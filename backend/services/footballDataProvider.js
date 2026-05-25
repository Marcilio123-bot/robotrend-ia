/**
 * Robotrend IA — football-data.org Provider
 *
 * Provider GRATUITO LEGÍTIMO. Precisa de chave grátis (sem cartão) em
 * https://www.football-data.org/client/register
 *
 * Plano TIER ONE (free):
 *   - 10 requests/minuto
 *   - 12 competições principais incluídas (Premier League, Brasileirão, La Liga,
 *     Serie A, Bundesliga, Ligue 1, Champions, Eredivisie, Primeira Liga,
 *     Championship, Copa Libertadores, World Cup)
 *   - Endpoint live: GET /v4/matches?status=LIVE
 *   - Score + minute + status (sem stats avançadas → vira dataQuality='partial')
 *
 * Env vars:
 *   FOOTBALL_DATA_KEY = sua chave (obrigatório)
 *   FOOTBALL_DATA_TIMEOUT_MS, FOOTBALL_DATA_TTL_LIVE_MS opcionais
 *
 * Interface compatível com apiFootball.js.
 */

'use strict';

const axios = require('axios');

const BASE_URL = (process.env.FOOTBALL_DATA_BASE_URL || 'https://api.football-data.org/v4').replace(/\/+$/, '');
const API_KEY  = String(process.env.FOOTBALL_DATA_KEY || '').trim();

const TIMEOUT_MS  = Number(process.env.FOOTBALL_DATA_TIMEOUT_MS || 10_000);
const RETRY_MAX   = Number(process.env.FOOTBALL_DATA_RETRY_MAX || 3);
const RETRY_DELAY = Number(process.env.FOOTBALL_DATA_RETRY_DELAY_MS || 800);
const TTL_LIVE    = Number(process.env.FOOTBALL_DATA_TTL_LIVE_MS || 30_000); // 10 req/min ⇒ 30s seguro

const CB_THRESHOLD = Number(process.env.FOOTBALL_DATA_CB_THRESHOLD || 10);
const CB_COOLDOWN  = Number(process.env.FOOTBALL_DATA_CB_COOLDOWN_MS || 60_000);

const client = API_KEY ? axios.create({
  baseURL: BASE_URL,
  timeout: TIMEOUT_MS,
  headers: {
    'X-Auth-Token': API_KEY,
    'Accept': 'application/json',
    'User-Agent': 'Robotrend/5 (+https://robotrend.local)',
  },
  decompress: true,
  validateStatus: (s) => s >= 200 && s < 500,
}) : null;

/* ============================================================
   CACHE + BREAKER (mesma estrutura dos outros providers)
   ============================================================ */
const cache = new Map();
function cacheGet(k) { const e = cache.get(k); if (!e) return null; if (e.exp < Date.now()) { cache.delete(k); return null; } return e.data; }
function cacheSet(k, data, ttl) { cache.set(k, { data, exp: Date.now() + ttl }); }

const breaker = {
  state: 'CLOSED', failures: 0, openedAt: 0, lastError: null,
  totals: { exec: 0, fail: 0, shortCircuit: 0 },
  snapshot() { return { name: 'football-data', state: this.state, failures: this.failures, openedAt: this.openedAt || null, lastError: this.lastError, totals: { ...this.totals } }; },
};

function breakerAllow() {
  if (breaker.state === 'CLOSED') return true;
  if (Date.now() - breaker.openedAt >= CB_COOLDOWN) {
    breaker.state = 'CLOSED';
    breaker.failures = 0;
    console.log('[BREAKER CLOSED] football-data cooldown elapsed');
    return true;
  }
  breaker.totals.shortCircuit++;
  return false;
}

function isTransient(err) {
  const code = err?.code || '';
  if (['ECONNRESET','ECONNABORTED','ETIMEDOUT','ECONNREFUSED','ENOTFOUND','EAI_AGAIN','EPIPE','EHOSTUNREACH'].includes(code)) return true;
  if (/timeout|socket hang up|network/i.test(String(err?.message || ''))) return true;
  const s = err?.status;
  if (s === 429) return true; // rate-limit é transitório
  if (s >= 500 && s < 600) return true;
  return false;
}

function breakerRecord(success, err) {
  if (success) {
    breaker.failures = 0;
    breaker.state = 'CLOSED';
    return;
  }
  if (isTransient(err)) { breaker.totals.fail++; breaker.lastError = err?.message || String(err); return; }
  breaker.failures++;
  breaker.lastError = err?.message || String(err);
  breaker.totals.fail++;
  if (breaker.failures >= CB_THRESHOLD && breaker.state === 'CLOSED') {
    breaker.state = 'OPEN';
    breaker.openedAt = Date.now();
    console.warn(`[BREAKER OPEN] football-data após ${breaker.failures} falhas — ${CB_COOLDOWN}ms`);
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function httpGet(pathname) {
  if (!client) {
    const err = new Error('FOOTBALL_DATA_KEY ausente — provider desativado');
    err.code = 'NO_KEY';
    throw err;
  }
  if (!breakerAllow()) {
    const err = new Error('breaker OPEN');
    err.code = 'CIRCUIT_OPEN';
    throw err;
  }
  console.log('[FETCH] football-data', pathname);
  for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
    breaker.totals.exec++;
    try {
      const res = await client.get(pathname);
      if (res.status >= 200 && res.status < 300) {
        breakerRecord(true);
        console.log('[FETCH OK] football-data', pathname);
        return res.data;
      }
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      err.body = res.data;
      // 403/401 → chave inválida; propaga IMEDIATAMENTE para o switch trocar
      if (res.status === 403 || res.status === 401) {
        breakerRecord(false, err);
        console.warn('[FETCH ERROR] football-data auth', res.status, '(verifique FOOTBALL_DATA_KEY)');
        throw err;
      }
      if (res.status === 404) {
        breakerRecord(false, err);
        return null;
      }
      throw err;
    } catch (err) {
      if (err.status === 403 || err.status === 401) throw err;
      if (attempt < RETRY_MAX) {
        const wait = RETRY_DELAY * Math.pow(2, attempt - 1);
        console.log('[FETCH RETRY] football-data', pathname, attempt, 'wait', wait, err.message);
        await sleep(wait);
        continue;
      }
      breakerRecord(false, err);
      console.warn('[FETCH ERROR] football-data', pathname, err.message);
      return null;
    }
  }
  return null;
}

/* ============================================================
   NORMALIZAÇÃO
   ============================================================ */
const FT_RX = /^(FINISHED|AWARDED|POSTPONED|CANCELLED|SUSPENDED)$/i;
function statusShort(raw) {
  const s = String(raw || '').toUpperCase();
  if (s === 'IN_PLAY') return 'LIVE';
  if (s === 'PAUSED') return 'HT';
  if (FT_RX.test(s)) return 'FT';
  if (s === 'TIMED' || s === 'SCHEDULED') return 'NS';
  return s || 'LIVE';
}

function parseMinute(m) {
  // football-data: m.minute pode vir como string "45+2" ou number
  const raw = m?.minute ?? m?.injuryTime;
  if (typeof raw === 'number') return raw;
  const num = parseInt(String(raw || '').replace(/[^\d]/g, ''), 10);
  return Number.isFinite(num) ? num : 0;
}

function normalizeMatch(item) {
  if (!item || !item.id) return null;
  const status = statusShort(item.status);
  if (status === 'FT' || status === 'NS') return null; // não-live

  const home = item.homeTeam || {};
  const away = item.awayTeam || {};
  const sh = item.score?.fullTime?.home ?? item.score?.halfTime?.home ?? 0;
  const sa = item.score?.fullTime?.away ?? item.score?.halfTime?.away ?? 0;
  const minute = parseMinute(item);
  const dateIso = item.utcDate || null;

  const id = String(item.id);
  return {
    id,
    fixtureId: item.id,
    league: {
      id: item.competition?.id,
      name: item.competition?.name || 'Liga',
      country: item.area?.name || '',
      logo: item.competition?.emblem || null,
      flag: item.area?.flag || null,
      season: item.season?.id || null,
      round: item.matchday || null,
    },
    teams: {
      home: { id: home.id, name: home.name || home.shortName || 'Casa', logo: home.crest || null },
      away: { id: away.id, name: away.name || away.shortName || 'Visitante', logo: away.crest || null },
    },
    home: home.name || 'Casa',
    away: away.name || 'Visitante',
    minute,
    status,
    statusLong: item.status || 'Ao vivo',
    venue: null,
    kickoffAt: dateIso,
    date: dateIso,
    score: {
      home: Number(sh) || 0,
      away: Number(sa) || 0,
      ht: { home: item.score?.halfTime?.home ?? null, away: item.score?.halfTime?.away ?? null },
      ft: null,
      halftime: { home: item.score?.halfTime?.home ?? null, away: item.score?.halfTime?.away ?? null },
      fulltime: null,
    },
    stats: null,
    perMinute: null,
    events: [],
    enriched: false,
    enrichedAt: null,
    flags: { isLive: true, isFinished: false, isFromLiveAPI: true, source: 'football-data' },
    lastApiUpdate: Date.now(),
    fixture: {
      id: item.id,
      date: dateIso,
      status: { short: status, long: item.status, elapsed: minute },
      venue: { name: null, city: null },
      referee: null,
    },
    goals: { home: Number(sh) || 0, away: Number(sa) || 0 },
  };
}

/* ============================================================
   PUBLIC API
   ============================================================ */
function isConfigured() { return !!API_KEY; }

async function getLiveFixtures() {
  if (!API_KEY) {
    const empty = [];
    Object.defineProperty(empty, '__stale', { value: true, enumerable: false });
    Object.defineProperty(empty, '__fallbackReason', { value: 'no_football_data_key', enumerable: false });
    return empty;
  }
  const cached = cacheGet('live');
  if (cached) return cached;
  const data = await httpGet('/matches?status=LIVE');
  if (!data || !Array.isArray(data.matches)) {
    const empty = [];
    Object.defineProperty(empty, '__stale', { value: true, enumerable: false });
    Object.defineProperty(empty, '__fallbackReason', { value: 'football_data_unavailable', enumerable: false });
    return empty;
  }
  const normalized = data.matches.map(normalizeMatch).filter(Boolean);
  cacheSet('live', normalized, TTL_LIVE);
  return normalized;
}

// Stubs — football-data não tem stats granulares no free tier
async function getFixtureById()        { return []; }
async function getFixtureStatistics()  { return []; }
async function getFixtureEvents()      { return []; }
async function getFixtureLineups()     { return []; }
async function getFixturesByDate()     { return []; }
async function getFixturesByTeam()     { return []; }
async function getHeadToHead()         { return []; }
async function getPredictions()        { return []; }
async function getOdds()               { return []; }
async function getOddsLive()           { return []; }
async function getTeamStatistics()     { return null; }
async function getLeagues()            { return []; }

function isSafeMode() { return breaker.state === 'OPEN'; }
function safeMode() { return { active: breaker.state === 'OPEN', reason: breaker.state === 'OPEN' ? 'football_data_breaker_open' : null, since: breaker.openedAt || null }; }
function remainingRatio() { return breaker.state === 'OPEN' ? 0 : 1; }
function quota() { return { dailyLimit: null, dailyRemaining: null, minuteLimit: 10, minuteRemaining: null, lastUpdated: null, lastResponseAt: null, provider: 'football-data' }; }
function status() {
  return {
    provider: 'football-data',
    configured: isConfigured(),
    keyValid: !!API_KEY,
    hasKey: !!API_KEY,
    host: 'api.football-data.org',
    baseURL: BASE_URL,
    legacyRapidApi: false,
    httpClientReady: !!client,
    timeoutMs: TIMEOUT_MS,
    retryMax: RETRY_MAX,
    rateLimit: { perMin: 10, perDay: null, windowUsed: 0, dayUsed: 0 },
    quota: quota(),
    cacheStore: { backend: 'memory', size: cache.size },
    inflight: 0,
    breaker: breaker.snapshot(),
    safeMode: safeMode(),
  };
}
async function cacheClear(prefix) {
  let n = 0;
  for (const k of [...cache.keys()]) { if (!prefix || k.startsWith(prefix)) { cache.delete(k); n++; } }
  return n;
}

module.exports = {
  isConfigured,
  status,
  cacheClear,
  quota,
  breaker,
  isSafeMode,
  safeMode,
  remainingRatio,
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
  normalizeMatch,
};
