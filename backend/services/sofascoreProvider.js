/**
 * Robotrend IA — Sofascore Provider
 *
 * IMPORTANTE: `api.sofascore.com` é uma API INTERNA NÃO-PÚBLICA da Sofascore.
 * Não há contrato comercial nem SLA. Em produção:
 *   - Cloudflare pode bloquear IPs com fingerprint de scraper
 *   - rotas e schemas podem mudar sem aviso
 *   - rate limit é arbitrário e não documentado
 *
 * Estratégia de defesa:
 *   - cache agressivo por endpoint (TTL = `SOFASCORE_TTL_*` envs)
 *   - User-Agent realista + Referer/Origin do site oficial
 *   - retry com backoff exponencial (3 tentativas)
 *   - circuit breaker simples (5 falhas → cooldown 60s)
 *   - todas as funções de fetch retornam fallback vazio em erro (nunca throw)
 *
 * Interface pública é compatível com `apiFootball.js` para que os
 * consumidores (poller, enricher, consensus, routes) não precisem mudar.
 */

'use strict';

const axios = require('axios');
const { logger } = require('../logger');
const metrics = require('../services/metrics');

const log = logger.child({ module: 'sofascore' });

// Lista ordenada de bases. Tentamos a primeira; em falha (não 4xx), caímos
// para a próxima. `www.sofascore.com/api/v1/...` é o domínio público que o
// próprio site usa — costuma sofrer menos bloqueio de Cloudflare que o
// subdomínio `api.sofascore.com`.
const BASE_URLS = (process.env.SOFASCORE_BASE_URLS || 'https://www.sofascore.com/api/v1,https://api.sofascore.com/api/v1')
  .split(',')
  .map((s) => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Referer': 'https://www.sofascore.com/',
  'Origin':  'https://www.sofascore.com',
  'Sec-Ch-Ua': '"Chromium";v="124", "Not-A.Brand";v="99"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
  'DNT': '1',
};

const TIMEOUT_MS  = Number(process.env.SOFASCORE_TIMEOUT_MS || 10_000);
const RETRY_MAX   = Number(process.env.SOFASCORE_RETRY_MAX || 3);
const RETRY_DELAY = Number(process.env.SOFASCORE_RETRY_DELAY_MS || 800);

const TTL_LIVE      = Number(process.env.SOFASCORE_TTL_LIVE_MS    || 15_000);
const TTL_DETAILS   = Number(process.env.SOFASCORE_TTL_DETAILS_MS || 60_000);
const TTL_STATS     = Number(process.env.SOFASCORE_TTL_STATS_MS   || 20_000);
const TTL_INCIDENTS = Number(process.env.SOFASCORE_TTL_INCIDENTS_MS || 15_000);
const TTL_LINEUPS   = Number(process.env.SOFASCORE_TTL_LINEUPS_MS || 5 * 60_000);
const TTL_ODDS      = Number(process.env.SOFASCORE_TTL_ODDS_MS    || 60_000);

// Breaker tolerante: precisa de 10 falhas seguidas para abrir. Cooldown 60s.
// Erros transientes (timeout, ECONN*, 503) NÃO incrementam o contador.
const CB_THRESHOLD = Number(process.env.SOFASCORE_CB_THRESHOLD || 10);
const CB_COOLDOWN  = Number(process.env.SOFASCORE_CB_COOLDOWN_MS || 60_000);

/* ============================================================
   MÉTRICAS
   ============================================================ */
const m_calls   = metrics.counter('sofascore_calls_total', 'Chamadas ao api.sofascore.com');
const m_errors  = metrics.counter('sofascore_errors_total', 'Erros (network/4xx/5xx)');
const m_retries = metrics.counter('sofascore_retries_total');
const m_cache_hit = metrics.counter('sofascore_cache_hit_total');
const m_cache_miss = metrics.counter('sofascore_cache_miss_total');
const g_breaker = metrics.gauge('sofascore_breaker_open', '1 quando bloqueado por falhas consecutivas');

/* ============================================================
   AXIOS — um client por base URL para failover transparente
   ============================================================ */
const clients = BASE_URLS.map((base) =>
  axios.create({
    baseURL: base,
    timeout: TIMEOUT_MS,
    headers: DEFAULT_HEADERS,
    decompress: true,
    validateStatus: (s) => s >= 200 && s < 500,
  })
);

/* ============================================================
   CACHE em memória — TTL por chave
   ============================================================ */
const cache = new Map(); // key -> { data, expiresAt }

function cacheGet(key) {
  const ent = cache.get(key);
  if (!ent) { m_cache_miss.inc(); return null; }
  if (ent.expiresAt < Date.now()) {
    cache.delete(key);
    m_cache_miss.inc();
    return null;
  }
  m_cache_hit.inc();
  return ent.data;
}

function cacheSet(key, data, ttlMs) {
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
  // GC simples para não vazar memória se muitas fixtures forem consultadas
  if (cache.size > 2000) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (v.expiresAt < now) cache.delete(k);
    }
  }
}

/* ============================================================
   CIRCUIT BREAKER simples
   ============================================================ */
const breaker = {
  state: 'CLOSED',         // CLOSED | OPEN
  failures: 0,
  openedAt: 0,
  lastError: null,
  totals: { exec: 0, fail: 0, shortCircuit: 0 },
  snapshot() {
    return {
      name: 'sofascore',
      state: this.state,
      failures: this.failures,
      openedAt: this.openedAt || null,
      lastError: this.lastError ? String(this.lastError).slice(0, 200) : null,
      totals: { ...this.totals },
    };
  },
};

function breakerAllow() {
  if (breaker.state === 'CLOSED') return true;
  if (Date.now() - breaker.openedAt >= CB_COOLDOWN) {
    breaker.state = 'CLOSED';
    breaker.failures = 0;
    g_breaker.set(0);
    console.log('[BREAKER CLOSED] sofascore breaker resetado após cooldown');
    return true;
  }
  breaker.totals.shortCircuit++;
  return false;
}

/**
 * Erros TRANSIENTES (rede, timeout, 5xx, conexão fechada) NÃO devem
 * incrementar o contador do breaker — eles indicam instabilidade temporária
 * de rede, não um problema sistêmico que justifique pausar o provider.
 * Apenas erros 403/429 ("eu vejo você, scraper") e 4xx genuínos contam.
 */
function isTransientError(err) {
  const code = err?.code || '';
  if (['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ECONNREFUSED',
       'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH'].includes(code)) return true;
  const msg = String(err?.message || '');
  if (/timeout|socket hang up|network/i.test(msg)) return true;
  const status = err?.status;
  if (status >= 500 && status < 600) return true;
  return false;
}

function breakerRecord(success, err) {
  if (success) {
    if (breaker.failures > 0) {
      console.log('[BREAKER CLOSED] sofascore recuperado após', breaker.failures, 'falhas');
    }
    breaker.failures = 0;
    if (breaker.state !== 'CLOSED') {
      breaker.state = 'CLOSED';
      g_breaker.set(0);
    }
    return;
  }
  // Transiente: registra como totals.fail mas NÃO conta para o breaker
  if (isTransientError(err)) {
    breaker.totals.fail++;
    breaker.lastError = err?.message || String(err);
    return;
  }
  breaker.failures++;
  breaker.lastError = err?.message || String(err);
  breaker.totals.fail++;
  if (breaker.failures >= CB_THRESHOLD && breaker.state === 'CLOSED') {
    breaker.state = 'OPEN';
    breaker.openedAt = Date.now();
    g_breaker.set(1);
    console.warn(`[BREAKER OPEN] sofascore — ${breaker.failures} falhas consecutivas, pausando ${CB_COOLDOWN}ms`, breaker.lastError);
  }
}

/* ============================================================
   FETCH com retry + multi-base failover (nunca throw — null em falha)
   ============================================================ */
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function httpGet(pathname, opts = {}) {
  if (!breakerAllow()) {
    console.warn('[SOFASCORE ERROR] breaker OPEN — request short-circuit', pathname);
    return null;
  }

  let lastErr = null;
  console.log('[SOFASCORE FETCH]', pathname);

  // Tenta cada base URL em ordem
  for (let baseIdx = 0; baseIdx < clients.length; baseIdx++) {
    const client = clients[baseIdx];
    const baseLabel = BASE_URLS[baseIdx];

    for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
      breaker.totals.exec++;
      m_calls.inc(1, { endpoint: pathname });
      try {
        const res = await client.get(pathname, opts);
        if (res.status >= 200 && res.status < 300) {
          breakerRecord(true);
          console.log('[SOFASCORE OK]', pathname, baseIdx === 0 ? '(primary)' : `(fallback ${baseIdx})`);
          return res.data;
        }
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        err.body = res.data;
        m_errors.inc(1, { endpoint: pathname, status: String(res.status) });
        // 404 → fixture não existe; retorna null sem retry
        if (res.status === 404) {
          breakerRecord(false, err);
          return null;
        }
        if (res.status === 403 || res.status === 429) {
          console.warn('[SOFASCORE ERROR] bloqueio HTTP', res.status, baseLabel, pathname);
        }
        throw err;
      } catch (err) {
        lastErr = err;
        m_errors.inc(1, { endpoint: pathname, kind: err.code || 'unknown' });
        const isLastAttempt = attempt === RETRY_MAX;
        const isLastBase    = baseIdx === clients.length - 1;
        if (!isLastAttempt) {
          m_retries.inc(1, { endpoint: pathname });
          const wait = RETRY_DELAY * Math.pow(2, attempt - 1);
          console.log('[SOFASCORE RETRY]', baseLabel, pathname, 'attempt', attempt, 'waitMs', wait, err.message);
          await sleep(wait);
          continue;
        }
        if (!isLastBase) {
          console.warn('[SOFASCORE ERROR] base esgotada, trocando para próxima', baseLabel, err.message);
          break; // pula para próxima base URL
        }
        // última base, última tentativa
        breakerRecord(false, err);
        console.warn('[SOFASCORE ERROR] todas as bases falharam', pathname, err.message, err.code || '');
        return null;
      }
    }
  }
  return null;
}

/* ============================================================
   NORMALIZAÇÃO — saída idêntica ao `fixtureNormalizer.normalizeFixture()`
   ============================================================ */
const LIVE_STATUS_TYPES = new Set(['inprogress', 'live']);
const FINISHED_STATUS_TYPES = new Set(['finished', 'aftet', 'aet', 'ap', 'awarded']);

function statusShort(event) {
  const type = String(event?.status?.type || '').toLowerCase();
  if (LIVE_STATUS_TYPES.has(type)) return 'LIVE';
  if (FINISHED_STATUS_TYPES.has(type)) return 'FT';
  if (type === 'notstarted') return 'NS';
  if (type === 'postponed') return 'PST';
  if (type === 'canceled' || type === 'cancelled') return 'CANC';
  if (type === 'halftime') return 'HT';
  return String(event?.status?.code || type || 'LIVE').toUpperCase();
}

function statusLong(event) {
  return (
    event?.status?.description ||
    event?.statusDescription ||
    event?.status?.type ||
    'Ao vivo'
  );
}

function liveMinute(event) {
  // Sofascore live time:
  //   event.time = { currentPeriodStartTimestamp, initial, max, extra }
  //   event.lastPeriod ou event.statusTime relevantes
  // Para minute aproximada usamos (now - currentPeriodStartTimestamp) + initial.
  const t = event?.time;
  if (t?.currentPeriodStartTimestamp && typeof t.initial === 'number') {
    const elapsed = Math.floor((Date.now() / 1000 - t.currentPeriodStartTimestamp) + t.initial / 60);
    return Math.max(0, Math.min(120, elapsed));
  }
  if (typeof t?.minute === 'number') return t.minute;
  if (typeof event?.minute === 'number') return event.minute;
  return 0;
}

/**
 * Converte um `event` cru da Sofascore para o mesmo schema do
 * `fixtureNormalizer.normalizeFixture()`. Compatibilidade total com
 * o resto do pipeline (poller, enricher, signals, frontend).
 */
function normalizeMatch(event) {
  if (!event || !event.id) return null;
  const ss = statusShort(event);
  const isLive = ss === 'LIVE' || ss === 'HT';
  const isFinished = ss === 'FT';

  const home = {
    id: event.homeTeam?.id,
    name: event.homeTeam?.name || event.homeTeam?.shortName || 'Casa',
    logo: event.homeTeam?.id
      ? `https://api.sofascore.com/api/v1/team/${event.homeTeam.id}/image`
      : null,
  };
  const away = {
    id: event.awayTeam?.id,
    name: event.awayTeam?.name || event.awayTeam?.shortName || 'Visitante',
    logo: event.awayTeam?.id
      ? `https://api.sofascore.com/api/v1/team/${event.awayTeam.id}/image`
      : null,
  };

  const minute = isLive ? liveMinute(event) : 0;
  const dateIso = event.startTimestamp
    ? new Date(event.startTimestamp * 1000).toISOString()
    : null;
  const scoreHome = event.homeScore?.current ?? 0;
  const scoreAway = event.awayScore?.current ?? 0;
  const htHome = event.homeScore?.period1 ?? null;
  const htAway = event.awayScore?.period1 ?? null;

  const league = {
    id: event.tournament?.uniqueTournament?.id || event.tournament?.id,
    name: event.tournament?.name || 'Liga',
    country: event.tournament?.category?.name || 'World',
    logo: event.tournament?.uniqueTournament?.id
      ? `https://api.sofascore.com/api/v1/unique-tournament/${event.tournament.uniqueTournament.id}/image`
      : null,
    flag: null,
    season: event.season?.year || null,
    round: event.roundInfo?.round || null,
  };

  return {
    id: String(event.id),
    fixtureId: event.id,
    league,
    teams: { home, away },
    home: home.name,
    away: away.name,
    minute,
    status: ss,
    statusLong: statusLong(event),
    venue: event.venue?.stadium?.name || null,
    kickoffAt: dateIso,
    date: dateIso,
    score: {
      home: scoreHome,
      away: scoreAway,
      ht: { home: htHome, away: htAway },
      ft: isFinished ? { home: scoreHome, away: scoreAway } : null,
      halftime: { home: htHome, away: htAway },
      fulltime: isFinished ? { home: scoreHome, away: scoreAway } : null,
    },
    stats: null,
    perMinute: null,
    events: [],
    enriched: false,
    enrichedAt: null,
    flags: {
      isLive,
      isFinished,
      isFromLiveAPI: true,
      source: 'sofascore',
    },
    lastApiUpdate: Date.now(),
    // ------------------------------------------------------------------
    // SHADOW — espelha shape API-Sports cru para consumidores legados
    // (prelive.js / live.js / consensus.js / routes/football.js).
    // Não afeta o schema canônico acima; apenas evita edits invasivos.
    // ------------------------------------------------------------------
    fixture: {
      id: event.id,
      date: dateIso,
      status: { short: ss, long: statusLong(event), elapsed: minute },
      venue: { name: event.venue?.stadium?.name || null, city: event.venue?.city?.name || null },
      referee: event.referee?.name || null,
    },
    goals: { home: scoreHome, away: scoreAway },
  };
}

/* ============================================================
   ADAPTAÇÃO de stats Sofascore → shape esperado por
   `fixtureNormalizer.applyEnrichment()` (formato API-Sports).
   ============================================================
   Sofascore stats vêm em groups → statisticsItems com chaves
   como `cornerKicks`, `totalShotsOnGoal`, etc.
   Convertemos para:
     [{ team: { id }, statistics: [{ type, value }] }]
   onde `type` segue o vocabulário API-Sports.
   ============================================================ */
const SOFA_TO_APISPORTS = {
  cornerKicks: 'Corner Kicks',
  totalShotsOnGoal: 'Total Shots',
  shotsOnGoal: 'Shots on Goal',
  shotsOffGoal: 'Shots off Goal',
  yellowCards: 'Yellow Cards',
  redCards: 'Red Cards',
  fouls: 'Fouls',
  ballPossession: 'Ball Possession',
  passes: 'Total passes',
  accuratePasses: 'Passes %',
  // Sofascore não expõe "Dangerous Attacks" diretamente; aproximamos por "Attacks".
  totalShotsInsideBox: 'Shots insidebox',
  attacks: 'Attacks',
  bigChanceCreated: 'Goal Attempts',
};

function parseNumberLike(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  const s = String(v).replace('%', '').trim();
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Recebe a resposta crua de `/event/{id}/statistics` e devolve no formato
 * que `applyEnrichment()` consome. Inclui Dangerous Attacks aproximada.
 */
function adaptStatsToApiSports(rawStats, homeId, awayId) {
  if (!rawStats || !Array.isArray(rawStats.statistics)) return [];
  const all = rawStats.statistics.find((p) => p.period === 'ALL') || rawStats.statistics[0];
  if (!all || !Array.isArray(all.groups)) return [];

  const homeMap = new Map();
  const awayMap = new Map();
  for (const group of all.groups) {
    for (const item of group.statisticsItems || []) {
      const type = SOFA_TO_APISPORTS[item.key];
      if (!type) continue;
      homeMap.set(type, parseNumberLike(item.homeValue ?? item.home));
      awayMap.set(type, parseNumberLike(item.awayValue ?? item.away));
    }
  }

  // Aproximação de "Dangerous Attacks" a partir de big chances + ataques na área
  const dangH =
    (homeMap.get('Goal Attempts') || 0) * 5 + (homeMap.get('Shots insidebox') || 0) * 2;
  const dangA =
    (awayMap.get('Goal Attempts') || 0) * 5 + (awayMap.get('Shots insidebox') || 0) * 2;
  if (dangH || dangA) {
    homeMap.set('Dangerous Attacks', dangH);
    awayMap.set('Dangerous Attacks', dangA);
  }

  return [
    { team: { id: homeId || 'home' }, statistics: [...homeMap].map(([type, value]) => ({ type, value })) },
    { team: { id: awayId || 'away' }, statistics: [...awayMap].map(([type, value]) => ({ type, value })) },
  ];
}

/**
 * Sofascore incidents → events shape compatível.
 */
function adaptIncidentsToEvents(rawIncidents) {
  if (!rawIncidents || !Array.isArray(rawIncidents.incidents)) return [];
  return rawIncidents.incidents
    .filter((i) => i.incidentType)
    .map((i) => ({
      time: { elapsed: i.time ?? 0, extra: i.addedTime ?? null },
      team: { id: i.isHome ? 'home' : 'away', name: i.isHome ? 'home' : 'away' },
      type: i.incidentType,                         // 'goal' | 'card' | 'substitution' | 'period' | ...
      detail: i.incidentClass || i.scoringTeam || i.cardType || i.incidentType,
      assist: i.assist1?.name || null,
      player: i.player?.name || null,
      raw: i,
    }));
}

/* ============================================================
   PUBLIC API — interface compatível com `apiFootball.js`
   ============================================================ */

function isConfigured() {
  // Sofascore não exige API key
  return true;
}

/* Status whitelist: somente partidas REALMENTE em andamento entram. */
const LIVE_OK_TYPES = new Set(['inprogress', 'live']);
const FT_TYPES = new Set([
  'finished', 'aftet', 'aet', 'ap', 'awarded', 'postponed', 'canceled', 'cancelled', 'suspended',
]);

function isLiveOk(rawEvent) {
  const type = String(rawEvent?.status?.type || '').toLowerCase();
  if (FT_TYPES.has(type)) return false;
  if (LIVE_OK_TYPES.has(type)) return true;
  // status desconhecido — só passa se tem placar/minuto sugerindo jogo ativo
  return false;
}

/** Lista de fixtures live, já normalizadas no schema do projeto. */
async function getLiveFixtures(_opts = {}) {
  const cached = cacheGet('live');
  if (cached) return cached;
  const data = await httpGet('/sport/football/events/live');
  if (!data || !Array.isArray(data.events)) {
    // Retorna array vazio LIMPO (sem cache stale) para que o poller decida
    // o que fazer (fallback clock simulado ou empty).
    const empty = [];
    Object.defineProperty(empty, '__stale', { value: true, enumerable: false });
    Object.defineProperty(empty, '__fallbackReason', { value: 'sofascore_unavailable', enumerable: false });
    return empty;
  }
  const normalized = data.events
    .filter(isLiveOk)               // drop FT/AET/PEN/etc.
    .map(normalizeMatch)
    .filter(Boolean);
  cacheSet('live', normalized, TTL_LIVE);
  return normalized;
}

async function getFixtureById(id, _opts = {}) {
  if (!id) return [];
  const key = `details:${id}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const data = await httpGet(`/event/${id}`);
  if (!data?.event) return [];
  const out = [normalizeMatch(data.event)].filter(Boolean);
  cacheSet(key, out, TTL_DETAILS);
  return out;
}

async function getFixtureStatistics(id, _opts = {}) {
  if (!id) return [];
  const key = `stats:${id}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const [statsRaw, detailsRaw] = await Promise.all([
    httpGet(`/event/${id}/statistics`),
    httpGet(`/event/${id}`),
  ]);
  const ev = detailsRaw?.event;
  const homeId = ev?.homeTeam?.id;
  const awayId = ev?.awayTeam?.id;
  const adapted = adaptStatsToApiSports(statsRaw, homeId, awayId);
  cacheSet(key, adapted, TTL_STATS);
  return adapted;
}

async function getFixtureEvents(id, _opts = {}) {
  if (!id) return [];
  const key = `incidents:${id}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const data = await httpGet(`/event/${id}/incidents`);
  const adapted = adaptIncidentsToEvents(data);
  cacheSet(key, adapted, TTL_INCIDENTS);
  return adapted;
}

async function getFixtureLineups(id, _opts = {}) {
  if (!id) return [];
  const key = `lineups:${id}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const data = await httpGet(`/event/${id}/lineups`);
  if (!data) return [];
  cacheSet(key, data, TTL_LINEUPS);
  return data;
}

async function getOdds({ fixture } = {}, _opts = {}) {
  if (!fixture) return [];
  const key = `odds:${fixture}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const data = await httpGet(`/event/${fixture}/odds/1/all`);
  if (!data) return [];
  cacheSet(key, data, TTL_ODDS);
  return Array.isArray(data) ? data : [data];
}

async function getOddsLive({ fixture } = {}, _opts = {}) {
  // Sofascore não tem endpoint separado /odds/live — usa o mesmo endpoint
  return getOdds({ fixture });
}

async function getFixturesByDate(dateISO, _opts = {}) {
  if (!dateISO) return [];
  const key = `bydate:${dateISO}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const data = await httpGet(`/sport/football/scheduled-events/${dateISO}`);
  if (!data || !Array.isArray(data.events)) return [];
  const normalized = data.events.map(normalizeMatch).filter(Boolean);
  cacheSet(key, normalized, TTL_DETAILS);
  return normalized;
}

async function getFixturesByTeam(teamId, { last = 5 } = {}, _opts = {}) {
  if (!teamId) return [];
  const key = `teamlast:${teamId}:${last}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const data = await httpGet(`/team/${teamId}/events/last/0`);
  if (!data || !Array.isArray(data.events)) return [];
  const slice = data.events.slice(0, last).map(normalizeMatch).filter(Boolean);
  cacheSet(key, slice, TTL_DETAILS);
  return slice;
}

/* Stubs para endpoints API-Sports que Sofascore não expõe diretamente.
   Devolvem [] silenciosamente — frontend já tolera lista vazia. */
async function getHeadToHead() { return []; }
async function getPredictions() { return []; }
async function getTeamStatistics() { return null; }
async function getLeagues() { return []; }

/* ============================================================
   SAFE-MODE / QUOTA — Sofascore não tem quota com header.
   Tratamos breaker OPEN como equivalente a safe-mode.
   ============================================================ */
function isSafeMode() { return breaker.state === 'OPEN'; }
function safeMode() {
  return {
    active: breaker.state === 'OPEN',
    reason: breaker.state === 'OPEN' ? 'sofascore_breaker_open' : null,
    since: breaker.openedAt || null,
  };
}
function remainingRatio() {
  // sem quota oficial — usamos breaker como proxy
  return breaker.state === 'OPEN' ? 0 : 1;
}
function quota() {
  return {
    dailyLimit: null,
    dailyRemaining: null,
    minuteLimit: null,
    minuteRemaining: null,
    lastUpdated: null,
    lastResponseAt: null,
    provider: 'sofascore',
  };
}

function status() {
  return {
    provider: 'sofascore',
    configured: true,
    keyValid: true,
    hasKey: false,            // não exige chave
    host: 'www.sofascore.com',
    baseURL: BASE_URLS[0] || 'https://www.sofascore.com/api/v1',
    baseURLs: BASE_URLS,
    legacyRapidApi: false,
    httpClientReady: true,
    timeoutMs: TIMEOUT_MS,
    retryMax: RETRY_MAX,
    rateLimit: { perMin: null, perDay: null, windowUsed: 0, dayUsed: 0 },
    quota: quota(),
    cacheStore: { backend: 'memory', size: cache.size },
    inflight: 0,
    breaker: breaker.snapshot(),
    safeMode: safeMode(),
  };
}

async function cacheClear(prefix) {
  let n = 0;
  for (const k of [...cache.keys()]) {
    if (!prefix || k.startsWith(prefix)) {
      cache.delete(k);
      n++;
    }
  }
  return n;
}

/* ============================================================
   Helpers extras (não na API original, usados por rotas /football)
   ============================================================ */
async function fetchLiveMatches() { return getLiveFixtures(); }
async function fetchMatchDetails(id) { return httpGet(`/event/${id}`); }
async function fetchMatchStats(id)   { return httpGet(`/event/${id}/statistics`); }
async function fetchIncidents(id)    { return httpGet(`/event/${id}/incidents`); }
async function fetchLineups(id)      { return httpGet(`/event/${id}/lineups`); }
async function fetchOdds(id)         { return httpGet(`/event/${id}/odds/1/all`); }

module.exports = {
  // shape compatível com apiFootball.js
  isConfigured,
  status,
  cacheClear,
  quota,
  breaker,
  isSafeMode,
  safeMode,
  remainingRatio,
  // alto nível
  getLiveFixtures,
  getFixtureById,
  getFixturesByDate,
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
  // helpers do user (interface adicional)
  fetchLiveMatches,
  fetchMatchDetails,
  fetchMatchStats,
  fetchIncidents,
  fetchLineups,
  fetchOdds,
  // utilitários internos exportados para testes
  normalizeMatch,
  adaptStatsToApiSports,
  adaptIncidentsToEvents,
};
