/**
 * Robotrend IA — API-Football Service (API-Sports)
 *
 * Cliente único e centralizado para o endpoint direto da API-Sports.
 *   Base URL : https://v3.football.api-sports.io
 *   Header   : x-apisports-key (ÚNICO header de autenticação aceito)
 *
 * Suporta também o host legacy RapidAPI (`*.p.rapidapi.com`) — detectado
 * pelo host configurado.
 *
 * Funcionalidades:
 *   - Axios instance com headers sanitizados (remove User-Agent)
 *   - CacheStore plugável (memória / Redis via REDIS_URL)
 *   - Cache "fresh" (TTL curto) + cache "stale" (24h) p/ fallback
 *   - Deduplicação de in-flight requests
 *   - Rate limiter local (token bucket) + tracking de quota da API
 *   - Circuit breaker (CLOSED → OPEN após N falhas → HALF_OPEN p/ probe)
 *   - Fallback automático para stale cache quando o circuito está OPEN
 *   - Retry exponencial em 429 / 5xx / timeout
 *   - Emite eventos `quota`, `quota:low`, `circuit:open/close` no bus
 *
 * Endpoints expostos como helpers de alto nível:
 *   /fixtures (live, by id, by date, by team)
 *   /fixtures/statistics, /fixtures/events, /fixtures/lineups
 *   /fixtures/headtohead
 *   /predictions
 *   /odds, /odds/live
 *   /teams/statistics
 *   /leagues
 */

'use strict';

const axios = require('axios');
const http = require('http');
const https = require('https');

const { logger } = require('../logger');
const { getStore } = require('./cacheStore');
const { CircuitBreaker, CircuitBreakerOpenError } = require('./circuitBreaker');
const events = require('./footballEvents');
const metrics = require('./metrics');
const {
  normalizeHost,
  buildHttpsBase,
  buildRequestUrl,
  maskSecretsInUrl,
  logExternalRequest,
  isDnsOrNetworkSkip,
} = require('./externalApiGuard');

const log = logger.child({ module: 'api-football' });

/* ============================================================
   MÉTRICAS (registradas uma única vez)
   ============================================================ */
const m_calls          = metrics.counter('apifootball_calls_total', 'Chamadas à API-Sports');
const m_errors         = metrics.counter('apifootball_errors_total', 'Erros (network/4xx/5xx)');
const m_429            = metrics.counter('apifootball_429_total', 'Respostas 429');
const m_5xx            = metrics.counter('apifootball_5xx_total', 'Respostas 5xx');
const m_4xx            = metrics.counter('apifootball_4xx_total', 'Respostas 4xx (não 429)');
const m_timeout        = metrics.counter('apifootball_timeout_total', 'Timeouts');
const m_retries        = metrics.counter('apifootball_retries_total', 'Retries efetivos');
const m_stale_served   = metrics.counter('apifootball_stale_served_total', 'Respostas servidas do stale-cache');
const m_cache_hit      = metrics.counter('apifootball_cache_hit_total', 'Cache fresh HIT');
const m_cache_miss     = metrics.counter('apifootball_cache_miss_total', 'Cache fresh MISS');
const m_inflight_dedup = metrics.counter('apifootball_inflight_dedup_total', 'Requests deduplicados (in-flight join)');
const m_latency        = metrics.histogram('apifootball_latency_ms', 'Latência da API-Sports (ms)');
const m_calls_window   = metrics.window('apifootball_calls_window', { windowMs: 60_000, bucketMs: 1_000 });

const g_quota_daily_rem = metrics.gauge('apifootball_quota_daily_remaining');
const g_quota_min_rem   = metrics.gauge('apifootball_quota_minute_remaining');
const g_inflight        = metrics.gauge('apifootball_inflight');
const g_breaker_state   = metrics.gauge('apifootball_breaker_state', '0=closed,1=half-open,2=open');

/* ============================================================
   CONFIG — lido do process.env a cada checagem (sem fetch no load)
   ============================================================ */
const DEFAULT_HOST = 'v3.football.api-sports.io';

const DISABLED_API_KEYS = new Set([
  '', 'disabled', 'false', 'off', 'none', 'null', 'undefined', 'skip', 'no',
]);

function readApiKey() {
  return String(process.env.API_FOOTBALL_KEY ?? '').trim();
}

function isApiKeyValid(key) {
  const k = String(key ?? '').trim();
  if (!k || DISABLED_API_KEYS.has(k.toLowerCase())) return false;
  if (/^(your[-_]|xxx|placeholder|troque|change_me|test[-_]?key)/i.test(k)) return false;
  return k.length >= 8;
}

/** Resolve host + baseURL a partir do env atual (nunca dispara HTTP). */
function readConfig() {
  const key = readApiKey();
  const host = normalizeHost(process.env.API_FOOTBALL_HOST || DEFAULT_HOST)
    || normalizeHost(DEFAULT_HOST);
  const isRapidApi = /\.rapidapi\.com$/i.test(host);
  const baseURL = isRapidApi ? buildHttpsBase(host, 'v3') : buildHttpsBase(host);
  return { key, host, baseURL, isRapidApi };
}

/** Chave + host + baseURL válidos — único gate antes de qualquer HTTP. */
function isConfigured() {
  const c = readConfig();
  return isApiKeyValid(c.key) && Boolean(c.host && c.baseURL);
}

let _warnedNotConfigured = false;
function warnNotConfiguredOnce(reason) {
  if (_warnedNotConfigured) return;
  _warnedNotConfigured = true;
  const c = readConfig();
  log.warn('API-Football desabilitada (sem chamadas externas)', {
    reason,
    keyValid: isApiKeyValid(c.key),
    host: c.host || '(inválido)',
    baseURL: c.baseURL ? 'ok' : '(vazio)',
  });
}

/** Array vazio padrão para callers (live/prelive/poller). Sem I/O. */
function emptyFixturesArray(reason = 'not_configured') {
  const arr = [];
  Object.defineProperty(arr, '__skipped', { value: true, enumerable: false });
  Object.defineProperty(arr, '__reason', { value: reason, enumerable: false });
  return arr;
}

function emptyApiBody(reason = 'not_configured') {
  return { response: [], errors: [], __skipped: true, __reason: reason };
}

const TIMEOUT_MS       = Number(process.env.API_FOOTBALL_TIMEOUT_MS     || 12_000);
const RETRY_MAX        = Number(process.env.API_FOOTBALL_RETRY_MAX      || 2);
const RETRY_BASE_DELAY = Number(process.env.API_FOOTBALL_RETRY_DELAY_MS || 1_000);

const RATE_PER_MIN     = Number(process.env.API_FOOTBALL_RATE_PER_MIN || 5);
const RATE_PER_DAY     = Number(process.env.API_FOOTBALL_RATE_PER_DAY || 95);

const DEFAULT_TTL_MS   = Number(process.env.API_FOOTBALL_CACHE_TTL_MS || 60_000);
const STALE_TTL_MS     = Number(process.env.API_FOOTBALL_STALE_TTL_MS || 24 * 3_600_000);

// Quota thresholds (fração RESTANTE)
//   QUOTA_LOW_PCT     → emite alerta `quota:low` no event bus (default 20%)
//   QUOTA_SAFE_PCT    → entra em SAFE-MODE: corta enrichment, prelive, consensus,
//                       responde do cache/stale sempre que possível (default 20%)
const QUOTA_LOW_PCT    = Number(process.env.API_FOOTBALL_QUOTA_LOW_PCT  || 0.20);
const QUOTA_SAFE_PCT   = Number(process.env.API_FOOTBALL_QUOTA_SAFE_PCT || 0.20);

const CB_THRESHOLD     = Number(process.env.API_FOOTBALL_CB_THRESHOLD  || 5);
const CB_COOLDOWN_MS   = Number(process.env.API_FOOTBALL_CB_COOLDOWN_MS || 60_000);

/**
 * TTL por endpoint (ms). Conservador. Livre para tunar via env.
 */
const TTL_BY_ENDPOINT = {
  'fixtures?live=all'      : Number(process.env.AF_TTL_LIVE         || 8_000),
  'fixtures'               : Number(process.env.AF_TTL_FIXTURES     || 60_000),
  'fixtures/statistics'    : Number(process.env.AF_TTL_STATS        || 12_000),
  'fixtures/events'        : Number(process.env.AF_TTL_EVENTS       || 12_000),
  'fixtures/lineups'       : Number(process.env.AF_TTL_LINEUPS      || 5 * 60_000),
  'fixtures/headtohead'    : Number(process.env.AF_TTL_H2H          || 30 * 60_000),
  'predictions'            : Number(process.env.AF_TTL_PREDICTIONS  || 10 * 60_000),
  'odds'                   : Number(process.env.AF_TTL_ODDS         || 60_000),
  'odds/live'              : Number(process.env.AF_TTL_ODDS_LIVE    || 15_000),
  'teams/statistics'       : Number(process.env.AF_TTL_TEAM_STATS   || 30 * 60_000),
  'leagues'                : Number(process.env.AF_TTL_LEAGUES      || 24 * 3600_000),
};

/* ============================================================
   AXIOS — criado só quando a API está configurada (lazy, sem rede no load)
   ============================================================ */
const httpAgent  = new http.Agent ({ keepAlive: true, maxSockets: 25 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 25 });

let _httpClient = null;

function buildAuthHeaders(cfg = readConfig()) {
  if (cfg.isRapidApi) {
    return { 'x-rapidapi-key': cfg.key, 'x-rapidapi-host': cfg.host };
  }
  return { 'x-apisports-key': cfg.key };
}

function getHttpClient() {
  if (!isConfigured()) return null;
  if (_httpClient) return _httpClient;
  const cfg = readConfig();
  _httpClient = axios.create({
    baseURL: cfg.baseURL,
    timeout: TIMEOUT_MS,
    headers: { Accept: 'application/json' },
    httpAgent,
    httpsAgent,
    decompress: true,
    validateStatus: (s) => s >= 200 && s < 500,
  });
  _httpClient.interceptors.request.use((reqCfg) => {
    reqCfg.headers = reqCfg.headers || {};
    const drop = ['User-Agent', 'user-agent'];
    for (const h of drop) {
      try { delete reqCfg.headers[h]; } catch (_) {}
      if (typeof reqCfg.headers.set === 'function') {
        try { reqCfg.headers.set(h, null); } catch (_) {}
      }
    }
    for (const [k, v] of Object.entries(buildAuthHeaders(cfg))) {
      if (typeof reqCfg.headers.set === 'function') reqCfg.headers.set(k, v);
      else reqCfg.headers[k] = v;
    }
    return reqCfg;
  });
  return _httpClient;
}

/* ============================================================
   QUOTA TRACKING
   ============================================================ */
const quota = {
  dailyLimit: null, dailyRemaining: null,
  minuteLimit: null, minuteRemaining: null,
  lastUpdated: null, lastResponseAt: null,
  errors: { total: 0, last429At: null, last5xxAt: null, lastTimeoutAt: null },
};

function readHeader(headers, name) {
  if (!headers) return null;
  let v;
  if (typeof headers.get === 'function') v = headers.get(name) ?? headers.get(name.toLowerCase());
  else v = headers[name] || headers[name.toLowerCase()];
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}

let lastLowEmitAt = 0;
function maybeEmitQuotaLow() {
  if (quota.dailyLimit == null || quota.dailyRemaining == null) return;
  const ratio = quota.dailyRemaining / quota.dailyLimit;
  if (ratio > QUOTA_LOW_PCT) return;
  if (Date.now() - lastLowEmitAt < 60_000) return; // throttle 1/min
  lastLowEmitAt = Date.now();
  events.emit('quota:low', { remaining: quota.dailyRemaining, limit: quota.dailyLimit, ratio });
}

/* ============================================================
   SAFE-MODE — quando a quota está acabando OU o circuito está OPEN,
   o sistema deve evitar QUALQUER chamada não-essencial à API:
     - enricher para de enfileirar
     - prelive devolve []
     - consensus engine desativa
     - apenas o poller central continua, com TTL aumentado
   ============================================================ */
let _safeMode = false;
let _safeModeAt = 0;

/**
 * Calcula a fração de quota restante combinando:
 *   1. Headers da API (quota oficial)
 *   2. Contador local (bucket.dayUsed / RATE_PER_DAY) — fallback antes do
 *      primeiro response, ou se a API não devolveu o header
 */
function remainingRatio() {
  if (quota.dailyLimit && quota.dailyRemaining != null) {
    return quota.dailyRemaining / quota.dailyLimit;
  }
  if (RATE_PER_DAY > 0) {
    const used = bucket.dayUsed || 0;
    return Math.max(0, (RATE_PER_DAY - used) / RATE_PER_DAY);
  }
  return 1;
}

function evaluateSafeMode() {
  const ratio = remainingRatio();
  const shouldBeSafe = ratio <= QUOTA_SAFE_PCT;
  if (shouldBeSafe && !_safeMode) {
    _safeMode = true;
    _safeModeAt = Date.now();
    log.warn('SAFE-MODE activated', { ratio, threshold: QUOTA_SAFE_PCT });
    events.emit('quota:safe-mode', { active: true, ratio, threshold: QUOTA_SAFE_PCT });
  } else if (!shouldBeSafe && _safeMode) {
    // Só desativa se a quota REAL voltou (reset diário, header novo)
    _safeMode = false;
    log.info('SAFE-MODE deactivated', { ratio });
    events.emit('quota:safe-mode', { active: false, ratio });
  }
}

function isSafeMode() { return _safeMode; }
function safeModeSnapshot() {
  return {
    active: _safeMode,
    activatedAt: _safeModeAt || null,
    threshold: QUOTA_SAFE_PCT,
    ratio: remainingRatio(),
    quota: { dailyLimit: quota.dailyLimit, dailyRemaining: quota.dailyRemaining },
    bucket: { dayUsed: bucket.dayUsed, dayLimit: RATE_PER_DAY },
  };
}

function syncBreakerGauge() {
  const map = { CLOSED: 0, HALF_OPEN: 1, OPEN: 2 };
  g_breaker_state.set(map[breaker.state] ?? 0);
}

function updateQuotaFromHeaders(headers) {
  if (!headers) return;
  const dailyLimit = readHeader(headers, 'x-ratelimit-requests-limit');
  const dailyRem   = readHeader(headers, 'x-ratelimit-requests-remaining');
  const minLimit   = readHeader(headers, 'X-RateLimit-Limit');
  const minRem     = readHeader(headers, 'X-RateLimit-Remaining');
  if (dailyLimit != null) quota.dailyLimit     = dailyLimit;
  if (dailyRem   != null) { quota.dailyRemaining = dailyRem; g_quota_daily_rem.set(dailyRem); }
  if (minLimit   != null) quota.minuteLimit    = minLimit;
  if (minRem     != null) { quota.minuteRemaining = minRem; g_quota_min_rem.set(minRem); }
  quota.lastUpdated = Date.now();
  quota.lastResponseAt = Date.now();
  maybeEmitQuotaLow();
  evaluateSafeMode();
}

function quotaSnapshot() { return { ...quota, errors: { ...quota.errors } }; }

/* ============================================================
   RATE LIMITER (token bucket)
   ============================================================ */
const bucket = {
  windowStart: Date.now(), used: 0,
  dayKey: new Date().toISOString().slice(0, 10), dayUsed: 0,
};

function rollWindows() {
  const now = Date.now();
  if (now - bucket.windowStart >= 60_000) { bucket.windowStart = now; bucket.used = 0; }
  const dayKey = new Date(now).toISOString().slice(0, 10);
  if (dayKey !== bucket.dayKey) { bucket.dayKey = dayKey; bucket.dayUsed = 0; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function jitter(ms) { return Math.floor(ms * (0.7 + Math.random() * 0.6)); }

async function acquireSlot() {
  while (true) {
    rollWindows();
    if (bucket.used >= RATE_PER_MIN) {
      const wait = Math.max(50, 60_000 - (Date.now() - bucket.windowStart));
      log.warn('rate-limit local atingido (minuto)', { waitMs: wait });
      await sleep(wait);
      continue;
    }
    if (bucket.dayUsed >= RATE_PER_DAY) {
      throw new Error(`Rate limit diário local atingido (${RATE_PER_DAY}/dia)`);
    }
    if (quota.minuteRemaining != null && quota.minuteRemaining <= 1) {
      log.warn('quota da API quase esgotada (minuto) — aguardando 5s', { minuteRemaining: quota.minuteRemaining });
      await sleep(5_000);
      continue;
    }
    if (quota.dailyRemaining != null && quota.dailyRemaining <= 0) {
      throw new Error('Quota diária da API-Sports esgotada');
    }
    bucket.used    += 1;
    bucket.dayUsed += 1;
    // Re-avalia safe-mode com base no contador local (importante antes do
    // primeiro response que traga headers de quota)
    evaluateSafeMode();
    return;
  }
}

/* ============================================================
   CACHE (fresh + stale) — usa cacheStore plugável
   Keys:
     af:fresh:<endpoint>?<sortedParams>   (TTL curto)
     af:stale:<endpoint>?<sortedParams>   (TTL longo, fallback)
   ============================================================ */
let _store = null;
function getCacheStore() {
  if (!_store) _store = getStore();
  return _store;
}

const inflight = new Map();

const KP_FRESH = 'af:fresh:';
const KP_STALE = 'af:stale:';

function buildKey(endpoint, params) {
  const entries = Object.entries(params || {})
    .filter(([, v]) => v != null && v !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`);
  return `${endpoint}?${entries.join('&')}`;
}

function pickTtl(endpoint, paramsKey) {
  if (endpoint === 'fixtures' && paramsKey.includes('live=all')) {
    return TTL_BY_ENDPOINT['fixtures?live=all'];
  }
  if (TTL_BY_ENDPOINT[endpoint]) return TTL_BY_ENDPOINT[endpoint];
  return DEFAULT_TTL_MS;
}

async function cacheClear(prefix) {
  if (!isConfigured()) return 0;
  const store = getCacheStore();
  const n1 = await store.clear(KP_FRESH + (prefix || ''));
  const n2 = await store.clear(KP_STALE + (prefix || ''));
  return n1 + n2;
}

/* ============================================================
   CIRCUIT BREAKER
   ============================================================ */
const breaker = new CircuitBreaker({
  name: 'api-football',
  threshold: CB_THRESHOLD,
  cooldownMs: CB_COOLDOWN_MS,
  // Erros não-rede (4xx negocial) não devem trip o circuito. 5xx, timeout
  // e 429 (rate limit) sim.
  isFailure: (err) => {
    if (!err) return false;
    if (err.code === 'ECONNABORTED' || /timeout/i.test(err.message)) return true;
    if (err.code === 'CIRCUIT_OPEN') return false; // já está aberto, não conta
    if (typeof err.status === 'number' && err.status >= 400 && err.status < 500 && err.status !== 429) return false;
    return true;
  },
});

// Eventos do breaker → bus (para painel/alerts/telegram)
let _prevBreakerState = breaker.state;
setInterval(() => {
  if (breaker.state !== _prevBreakerState) {
    syncBreakerGauge();
    if (breaker.state === 'OPEN') events.emit('circuit:open', { name: breaker.name, lastError: breaker.lastError });
    if (breaker.state === 'CLOSED') events.emit('circuit:close', { name: breaker.name });
    _prevBreakerState = breaker.state;
  }
}, 1_000).unref?.();

/* ============================================================
   TEST HOOKS (apenas dev/staging — usado por validate-realtime)
   ============================================================ */
let __forceFail = null;
function setForceFail(mode) {
  // mode: null | 'timeout' | '5xx' | '429' | 'circuit-open'
  __forceFail = mode;
  if (mode === 'circuit-open') breaker._force('OPEN');
  if (mode === null) breaker._force('CLOSED');
  syncBreakerGauge();
}
function getForceFail() { return __forceFail; }

/* ============================================================
   RAW REQUEST (com retry interno por 429/5xx/timeout)
   ============================================================ */
async function rawGet(endpoint, params, attempt = 1) {
  if (!isConfigured()) {
    const err = new Error('API_FOOTBALL não configurada (chave ou host inválido)');
    err.code = 'API_NOT_CONFIGURED';
    throw err;
  }

  const cfg = readConfig();
  const client = getHttpClient();
  if (!client) {
    const err = new Error('HTTP client indisponível — API não configurada');
    err.code = 'API_NOT_CONFIGURED';
    throw err;
  }

  const requestUrl = buildRequestUrl(cfg.baseURL, endpoint, params);
  if (!requestUrl) {
    const err = new Error('URL da API-Football inválida (baseURL vazio)');
    err.code = 'API_URL_INVALID';
    throw err;
  }
  if (attempt === 1) {
    logExternalRequest('api-football', 'GET', requestUrl, { endpoint });
  }

  // Force-fail (test hook): simula falhas ANTES de bater na rede.
  if (__forceFail) {
    m_calls.inc(1, { endpoint, forced: 'true' });
    if (__forceFail === 'timeout') {
      const e = new Error('timeout (forced)'); e.code = 'ECONNABORTED';
      m_timeout.inc(1, { endpoint });
      if (attempt < RETRY_MAX) { m_retries.inc(1, { endpoint, reason: 'timeout' }); await sleep(jitter(RETRY_BASE_DELAY)); return rawGet(endpoint, params, attempt + 1); }
      throw e;
    }
    if (__forceFail === '5xx') {
      const e = new Error('forced 5xx'); e.status = 503;
      m_5xx.inc(1, { endpoint, status: '503' });
      if (attempt < RETRY_MAX) { m_retries.inc(1, { endpoint, reason: '5xx' }); await sleep(jitter(RETRY_BASE_DELAY)); return rawGet(endpoint, params, attempt + 1); }
      throw e;
    }
    if (__forceFail === '429') {
      const e = new Error('forced 429'); e.status = 429;
      m_429.inc(1, { endpoint });
      if (attempt < RETRY_MAX) { m_retries.inc(1, { endpoint, reason: '429' }); await sleep(jitter(RETRY_BASE_DELAY)); return rawGet(endpoint, params, attempt + 1); }
      throw e;
    }
  }

  await acquireSlot();
  m_calls.inc(1, { endpoint });
  m_calls_window.hit();
  const t0 = Date.now();
  let response;
  try {
    response = await client.get(`/${endpoint}`, { params });
  } catch (err) {
    quota.errors.total++;
    m_errors.inc(1, { endpoint, kind: 'network' });
    if (err.code === 'ECONNABORTED' || /timeout/i.test(err.message)) {
      quota.errors.lastTimeoutAt = Date.now();
      m_timeout.inc(1, { endpoint });
      log.warn('timeout API-Football', { endpoint, attempt, ms: Date.now() - t0 });
    } else {
      log.error('network error API-Football', {
        endpoint,
        attempt,
        err: err.message,
        code: err.code,
        url: maskSecretsInUrl(requestUrl),
      });
      if (isDnsOrNetworkSkip(err)) {
        log.warn('API-Football: host não resolvido — verifique API_FOOTBALL_HOST no Environment', {
          host: cfg.host,
        });
      }
    }
    if (attempt < RETRY_MAX) {
      m_retries.inc(1, { endpoint, reason: err.code === 'ECONNABORTED' ? 'timeout' : 'network' });
      await sleep(jitter(RETRY_BASE_DELAY * Math.pow(2, attempt - 1)));
      return rawGet(endpoint, params, attempt + 1);
    }
    throw err;
  }

  const latencyMs = Date.now() - t0;
  m_latency.observe(latencyMs, { endpoint });
  updateQuotaFromHeaders(response.headers);

  if (response.status === 429) {
    quota.errors.total++;
    quota.errors.last429At = Date.now();
    m_429.inc(1, { endpoint });
    const retryAfter = Number(readHeader(response.headers, 'retry-after')) || 0;
    const wait = retryAfter > 0
      ? retryAfter * 1000
      : jitter(RETRY_BASE_DELAY * Math.pow(2, attempt));
    log.warn('429 Too Many Requests — backoff', { endpoint, attempt, waitMs: wait });
    if (attempt < RETRY_MAX) {
      m_retries.inc(1, { endpoint, reason: '429' });
      await sleep(wait);
      return rawGet(endpoint, params, attempt + 1);
    }
    const err = new Error(`API-Football 429 após ${attempt} tentativas`);
    err.status = 429;
    throw err;
  }

  if (response.status >= 500) {
    quota.errors.total++;
    quota.errors.last5xxAt = Date.now();
    m_5xx.inc(1, { endpoint, status: String(response.status) });
    log.warn('5xx API-Football', { endpoint, attempt, status: response.status });
    if (attempt < RETRY_MAX) {
      m_retries.inc(1, { endpoint, reason: '5xx' });
      await sleep(jitter(RETRY_BASE_DELAY * Math.pow(2, attempt - 1)));
      return rawGet(endpoint, params, attempt + 1);
    }
    /* fallthrough: build error */
    const err = new Error(`API-Football ${response.status}`);
    err.status = response.status;
    throw err;
  }

  if (response.status >= 400) {
    quota.errors.total++;
    m_4xx.inc(1, { endpoint, status: String(response.status) });
    log.warn('4xx API-Football', { endpoint, status: response.status, data: trim(response.data) });
    const err = new Error(`API-Football ${response.status}`);
    err.status = response.status;
    err.body = response.data;
    throw err;
  }

  const body = response.data || {};
  const errs = body.errors;
  if (errs && (Array.isArray(errs) ? errs.length : Object.keys(errs).length)) {
    log.warn('API devolveu errors no body', { endpoint, errors: trim(errs) });
    const err = new Error(`API-Football body error: ${JSON.stringify(errs).slice(0, 200)}`);
    err.status = 502;
    err.body = body;
    throw err;
  }
  return body;
}

function trim(obj, max = 300) {
  try {
    const s = JSON.stringify(obj);
    return s.length > max ? s.slice(0, max) + '…' : s;
  } catch { return String(obj); }
}

/* ============================================================
   GET com cache fresh → cache stale (fallback) → API (circuit breaker)
   ============================================================ */
async function get(endpoint, params = {}, opts = {}) {
  if (!isConfigured()) {
    const c = readConfig();
    const reason = !isApiKeyValid(c.key)
      ? 'API_FOOTBALL_KEY ausente ou inválida'
      : 'API_FOOTBALL_HOST inválido';
    warnNotConfiguredOnce(reason);
    return emptyApiBody('not_configured');
  }

  const store = getCacheStore();
  const key = buildKey(endpoint, params);

  // 1) cache fresh
  if (!opts.force) {
    const cached = await store.get(KP_FRESH + key);
    if (cached) {
      m_cache_hit.inc(1, { endpoint });
      return cached;
    }
    m_cache_miss.inc(1, { endpoint });
    const pending = inflight.get(key);
    if (pending) {
      m_inflight_dedup.inc(1, { endpoint });
      return pending;
    }
  }

  // 2) SAFE-MODE: bloqueia qualquer chamada não essencial. O caller pode
  //    pedir `opts.essential=true` (poller central) para furar o gate, mas
  //    a maioria dos endpoints (enricher, prelive, consensus, trends) devem
  //    devolver stale-cache ou nada nesse modo.
  if (_safeMode && !opts.essential) {
    const stale = await store.get(KP_STALE + key);
    if (stale) {
      m_stale_served.inc(1, { endpoint, reason: 'safe-mode' });
      return Object.assign({}, stale, { __stale: true, __fallbackReason: 'safe-mode' });
    }
    const err = new Error('SAFE_MODE_NO_CACHE');
    err.code = 'SAFE_MODE';
    err.endpoint = endpoint;
    throw err;
  }

  const ttl = opts.ttl != null ? opts.ttl : pickTtl(endpoint, key);

  const promise = (async () => {
    try {
      const body = await breaker.exec(
        () => rawGet(endpoint, params),
        {
          // Fallback automático: se o circuito estiver OPEN ou se a chamada falhar,
          // tentamos servir do cache stale (válido por STALE_TTL_MS).
          fallback: async (err) => {
            const stale = await store.get(KP_STALE + key);
            if (stale) {
              m_stale_served.inc(1, { endpoint });
              log.warn('servindo stale-cache (fallback)', {
                endpoint, reason: err?.message || 'unknown',
              });
              return Object.assign({}, stale, { __stale: true, __fallbackReason: err?.message });
            }
            throw err;
          },
        }
      );

      syncBreakerGauge();
      // Persiste em fresh + stale (stale dura muito mais)
      if (!body.__stale) {
        await store.set(KP_FRESH + key, body, ttl);
        await store.set(KP_STALE + key, body, STALE_TTL_MS);
      }
      return body;
    } finally {
      inflight.delete(key);
      g_inflight.set(inflight.size);
    }
  })();

  inflight.set(key, promise);
  g_inflight.set(inflight.size);
  return promise;
}

/* ============================================================
   HELPERS DE ALTO NÍVEL
   ============================================================ */
async function fetchResponse(endpoint, params, opts) {
  if (!isConfigured()) {
    warnNotConfiguredOnce('fetchResponse bloqueado — API não configurada');
    return emptyFixturesArray('not_configured');
  }
  const body = await get(endpoint, params, opts);
  if (body.__skipped) return emptyFixturesArray(body.__reason || 'not_configured');
  const arr = Array.isArray(body.response) ? body.response : [];
  if (body.__stale) Object.defineProperty(arr, '__stale', { value: true, enumerable: false });
  return arr;
}

async function getLiveFixtures(opts = {}) {
  if (!isConfigured()) {
    warnNotConfiguredOnce('getLiveFixtures — sem API_FOOTBALL_KEY válida');
    return emptyFixturesArray('not_configured');
  }
  const merged = { essential: true, ...opts };
  return fetchResponse('fixtures', { live: 'all' }, merged);
}
async function getFixturesByDate(dateISO, opts = {})   { return fetchResponse('fixtures', { date: dateISO }, opts); }
async function getFixtureById(id, opts = {})           { return fetchResponse('fixtures', { id }, opts); }
async function getFixturesByTeam(teamId, { last, next, season, league } = {}, opts = {}) {
  const p = { team: teamId };
  if (last)   p.last   = last;
  if (next)   p.next   = next;
  if (season) p.season = season;
  if (league) p.league = league;
  return fetchResponse('fixtures', p, opts);
}
async function getFixtureStatistics(id, opts = {})    { return fetchResponse('fixtures/statistics', { fixture: id }, opts); }
async function getFixtureEvents(id, opts = {})        { return fetchResponse('fixtures/events',     { fixture: id }, opts); }
async function getFixtureLineups(id, opts = {})       { return fetchResponse('fixtures/lineups',    { fixture: id }, opts); }
async function getHeadToHead(t1, t2, { last = 10, league, season } = {}, opts = {}) {
  const p = { h2h: `${t1}-${t2}`, last };
  if (league) p.league = league;
  if (season) p.season = season;
  return fetchResponse('fixtures/headtohead', p, opts);
}
async function getPredictions(id, opts = {})          { return fetchResponse('predictions', { fixture: id }, opts); }
async function getOdds({ fixture, league, season, bet, bookmaker, page } = {}, opts = {}) {
  const p = {};
  if (fixture)   p.fixture   = fixture;
  if (league)    p.league    = league;
  if (season)    p.season    = season;
  if (bet)       p.bet       = bet;
  if (bookmaker) p.bookmaker = bookmaker;
  if (page)      p.page      = page;
  return fetchResponse('odds', p, opts);
}
async function getOddsLive({ fixture, league } = {}, opts = {}) {
  const p = {};
  if (fixture) p.fixture = fixture;
  if (league)  p.league  = league;
  return fetchResponse('odds/live', p, opts);
}
async function getTeamStatistics(teamId, leagueId, season, opts = {}) {
  const body = await get('teams/statistics', { team: teamId, league: leagueId, season }, opts);
  return body.response || null;
}
async function getLeagues(params = {}, opts = {}) { return fetchResponse('leagues', params, opts); }

/* ============================================================
   STATUS / DIAGNÓSTICO
   ============================================================ */
function status() {
  const c = readConfig();
  const configured = isConfigured();
  const cacheInfo = configured && _store && _store.info
    ? _store.info()
    : { backend: configured ? 'not_initialized' : 'disabled' };
  return {
    configured,
    keyValid: isApiKeyValid(c.key),
    hasKey: Boolean(c.key),
    host: c.host || null,
    baseURL: configured ? c.baseURL : null,
    legacyRapidApi: c.isRapidApi,
    httpClientReady: Boolean(_httpClient),
    timeoutMs: TIMEOUT_MS,
    retryMax: RETRY_MAX,
    rateLimit: {
      perMin: RATE_PER_MIN, perDay: RATE_PER_DAY,
      windowUsed: bucket.used, dayUsed: bucket.dayUsed,
    },
    quota: quotaSnapshot(),
    cacheStore: cacheInfo,
    inflight: inflight.size,
    breaker: breaker.snapshot(),
    safeMode: safeModeSnapshot(),
  };
}

module.exports = {
  // baixo nível
  get,
  rawGet,
  isConfigured,
  status,
  cacheClear,
  quota: quotaSnapshot,
  breaker,           // exposto para painel/telemetria
  setForceFail,      // TEST HOOK
  getForceFail,      // TEST HOOK
  readConfig,
  isApiKeyValid,
  emptyFixturesArray,

  // safe-mode / quota guard
  isSafeMode,
  safeMode: safeModeSnapshot,
  remainingRatio,

  // alto nível
  getLiveFixtures,
  getFixturesByDate,
  getFixtureById,
  getFixturesByTeam,
  getFixtureStatistics,
  getFixtureEvents,
  getFixtureLineups,
  getHeadToHead,
  getPredictions,
  getOdds,
  getOddsLive,
  getTeamStatistics,
  getLeagues,
};
