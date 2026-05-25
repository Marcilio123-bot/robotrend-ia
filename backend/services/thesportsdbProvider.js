/**
 * Robotrend IA — TheSportsDB Provider
 *
 * Provider GRATUITO sem chave (`API key = 3` é a chave pública/test).
 * Endpoint principal:
 *   GET https://www.thesportsdb.com/api/v1/json/3/livescore.php?s=Soccer
 *
 * Compatível com a interface do `apiFootball.js`/`sofascoreProvider.js`:
 *   getLiveFixtures, getFixtureStatistics, getFixtureEvents, isConfigured,
 *   status, isSafeMode, quota, breaker, etc.
 *
 * Estratégia:
 *   - TTL curto (15s) para evitar martelar o endpoint
 *   - retry com backoff (3 tentativas, max 60s)
 *   - 403/429 NUNCA contam para breaker (esse é o sintoma que move o switch
 *     no footballProvider, não pause o provider isolado)
 *   - breaker abre só após 10 falhas consecutivas; cooldown 60s
 *   - sem hold de cache stale (devolve [] limpo se falhar)
 */

'use strict';

const axios = require('axios');

const BASE_URL = (process.env.THESPORTSDB_BASE_URL || 'https://www.thesportsdb.com/api/v1/json').replace(/\/+$/, '');
const API_KEY  = String(process.env.THESPORTSDB_KEY || '3').trim() || '3'; // "3" = chave pública

const TIMEOUT_MS  = Number(process.env.THESPORTSDB_TIMEOUT_MS || 10_000);
const RETRY_MAX   = Number(process.env.THESPORTSDB_RETRY_MAX || 3);
const RETRY_DELAY = Number(process.env.THESPORTSDB_RETRY_DELAY_MS || 800);
const TTL_LIVE    = Number(process.env.THESPORTSDB_TTL_LIVE_MS || 15_000);

const CB_THRESHOLD = Number(process.env.THESPORTSDB_CB_THRESHOLD || 10);
const CB_COOLDOWN  = Number(process.env.THESPORTSDB_CB_COOLDOWN_MS || 60_000);

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
};

const client = axios.create({
  baseURL: `${BASE_URL}/${API_KEY}`,
  timeout: TIMEOUT_MS,
  headers: DEFAULT_HEADERS,
  decompress: true,
  validateStatus: (s) => s >= 200 && s < 500,
});

/* ============================================================
   CACHE simples por endpoint
   ============================================================ */
const cache = new Map();
function cacheGet(k) {
  const e = cache.get(k);
  if (!e) return null;
  if (e.exp < Date.now()) { cache.delete(k); return null; }
  return e.data;
}
function cacheSet(k, data, ttl) { cache.set(k, { data, exp: Date.now() + ttl }); }

/* ============================================================
   BREAKER + retry
   ============================================================ */
const breaker = {
  state: 'CLOSED', failures: 0, openedAt: 0, lastError: null,
  totals: { exec: 0, fail: 0, shortCircuit: 0 },
  snapshot() {
    return {
      name: 'thesportsdb',
      state: this.state,
      failures: this.failures,
      openedAt: this.openedAt || null,
      lastError: this.lastError,
      totals: { ...this.totals },
    };
  },
};

function breakerAllow() {
  if (breaker.state === 'CLOSED') return true;
  if (Date.now() - breaker.openedAt >= CB_COOLDOWN) {
    breaker.state = 'CLOSED';
    breaker.failures = 0;
    console.log('[BREAKER CLOSED] thesportsdb cooldown elapsed');
    return true;
  }
  breaker.totals.shortCircuit++;
  return false;
}

/** 403/429 e erros transientes (timeout, ECONN*, 5xx) NÃO contam para breaker. */
function isTransient(err) {
  const code = err?.code || '';
  if (['ECONNRESET','ECONNABORTED','ETIMEDOUT','ECONNREFUSED','ENOTFOUND','EAI_AGAIN','EPIPE','EHOSTUNREACH'].includes(code)) return true;
  if (/timeout|socket hang up|network/i.test(String(err?.message || ''))) return true;
  const s = err?.status;
  if (s === 403 || s === 429) return true;
  if (s >= 500 && s < 600) return true;
  return false;
}

function breakerRecord(success, err) {
  if (success) {
    if (breaker.failures > 0) {
      console.log('[BREAKER CLOSED] thesportsdb recuperado após', breaker.failures, 'falhas');
    }
    breaker.failures = 0;
    breaker.state = 'CLOSED';
    return;
  }
  if (isTransient(err)) {
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
    console.warn(`[BREAKER OPEN] thesportsdb após ${breaker.failures} falhas — pausando ${CB_COOLDOWN}ms`);
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * GET sem-throw com retry. Lança apenas em 403/429 para o footballProvider
 * trocar de provider (o erro carrega `status` para o switch detectar).
 */
async function httpGet(pathname) {
  if (!breakerAllow()) {
    const err = new Error('breaker OPEN');
    err.code = 'CIRCUIT_OPEN';
    throw err;
  }
  console.log('[FETCH] thesportsdb', pathname);
  let lastErr = null;
  for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
    breaker.totals.exec++;
    try {
      const res = await client.get(pathname);
      if (res.status >= 200 && res.status < 300) {
        breakerRecord(true);
        console.log('[FETCH OK] thesportsdb', pathname);
        return res.data;
      }
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      err.body = res.data;
      // 403/429 → propaga IMEDIATAMENTE para o footballProvider trocar
      if (res.status === 403 || res.status === 429) {
        breakerRecord(false, err);
        console.warn('[FETCH ERROR] thesportsdb bloqueio', res.status, pathname);
        throw err;
      }
      if (res.status === 404) {
        breakerRecord(false, err);
        return null;
      }
      throw err;
    } catch (err) {
      lastErr = err;
      // Já propagamos 403/429 acima — re-lança aqui também
      if (err.status === 403 || err.status === 429) throw err;
      if (attempt < RETRY_MAX) {
        const wait = RETRY_DELAY * Math.pow(2, attempt - 1);
        console.log('[FETCH RETRY] thesportsdb', pathname, 'attempt', attempt, 'wait', wait, err.message);
        await sleep(wait);
        continue;
      }
      breakerRecord(false, err);
      console.warn('[FETCH ERROR] thesportsdb', pathname, err.message, err.code || '');
      return null;
    }
  }
  return null;
}

/* ============================================================
   NORMALIZAÇÃO — mesmo schema do projeto (compatível com
   fixtureNormalizer + frontend).
   ============================================================ */
const LIVE_STATUS_RX = /^(1H|HT|2H|ET|BT|LIVE|INT|P|HALFTIME)$/i;
const FT_STATUS_RX   = /^(FT|AET|PEN|AWD|WO|ABD|CANC|FINISHED|MATCH FINISHED|POSTPONED|PST|SUSP)$/i;

function parseMinute(progress, status) {
  // strProgress vem como "45'", "HT", "FT", "23'", etc.
  const raw = String(progress || '').trim();
  const num = parseInt(raw.replace(/[^\d]/g, ''), 10);
  if (Number.isFinite(num) && num >= 0 && num <= 120) return num;
  const st = String(status || '').toUpperCase();
  if (st === 'HT') return 45;
  if (FT_STATUS_RX.test(st)) return 90;
  return 0;
}

function normalizeStatus(status) {
  const raw = String(status || '').toUpperCase().trim();
  if (LIVE_STATUS_RX.test(raw)) return raw;
  if (FT_STATUS_RX.test(raw)) return raw;
  if (!raw) return 'LIVE';
  return raw;
}

function normalizeLive(item) {
  if (!item || !(item.idEvent || item.idLiveScore)) return null;
  const status = normalizeStatus(item.strStatus || item.strProgress);
  // Drop FT direto na fonte — nunca volta da TheSportsDB para o pipeline.
  if (FT_STATUS_RX.test(status)) return null;

  const homeName = item.strHomeTeam || 'Casa';
  const awayName = item.strAwayTeam || 'Visitante';
  const homeScore = Number(item.intHomeScore ?? 0) || 0;
  const awayScore = Number(item.intAwayScore ?? 0) || 0;
  const minute = parseMinute(item.strProgress, item.strStatus);
  const dateIso = item.strTimestamp || item.dateEvent
    ? new Date(item.strTimestamp || `${item.dateEvent}T${item.strTime || '00:00:00'}Z`).toISOString()
    : null;
  const id = String(item.idEvent || item.idLiveScore);

  return {
    id,
    fixtureId: id,
    league: {
      id: item.idLeague || null,
      name: item.strLeague || 'Liga',
      country: item.strCountry || '',
      logo: item.strLeagueBadge || null,
      flag: null,
      season: item.strSeason || null,
      round: null,
    },
    teams: {
      home: { id: item.idHomeTeam, name: homeName, logo: item.strHomeTeamBadge || null },
      away: { id: item.idAwayTeam, name: awayName, logo: item.strAwayTeamBadge || null },
    },
    home: homeName,
    away: awayName,
    minute,
    status,
    statusLong: item.strStatus || item.strProgress || 'Ao vivo',
    venue: item.strVenue || null,
    kickoffAt: dateIso,
    date: dateIso,
    score: {
      home: homeScore,
      away: awayScore,
      ht: { home: null, away: null },
      ft: null,
      halftime: { home: null, away: null },
      fulltime: null,
    },
    stats: null,
    perMinute: null,
    events: [],
    enriched: false,
    enrichedAt: null,
    flags: {
      isLive: true,
      isFinished: false,
      isFromLiveAPI: true,
      source: 'thesportsdb',
    },
    lastApiUpdate: Date.now(),
    // shadow shape API-Sports (mantém consumers legados funcionando)
    fixture: {
      id,
      date: dateIso,
      status: { short: status, long: item.strStatus || 'Ao vivo', elapsed: minute },
      venue: { name: item.strVenue || null, city: null },
      referee: null,
    },
    goals: { home: homeScore, away: awayScore },
  };
}

/* ============================================================
   PUBLIC API
   ============================================================ */
function isConfigured() { return true; }

/**
 * AVISO: `/livescore.php` exige Patreon tier (pago) na API V1 atual.
 * No free tier (key "3") usamos `eventsday.php` que retorna eventos
 * agendados/em andamento/finalizados do dia. Filtramos os que estão
 * em progresso/agendados pelo strStatus.
 */
async function getLiveFixtures() {
  const cached = cacheGet('live');
  if (cached) return cached;

  // Tenta livescore primeiro (Patreon), cai para eventsday se falhar
  let raw = null;
  try {
    raw = await httpGet('/livescore.php?s=Soccer');
  } catch (_) { /* propaga só 403/429 */ }

  let events = raw?.livescore;
  if (!Array.isArray(events)) {
    // Fallback grátis: eventos do dia
    const today = new Date().toISOString().slice(0, 10);
    let day = null;
    try { day = await httpGet(`/eventsday.php?d=${today}&s=Soccer`); }
    catch (_) {}
    events = Array.isArray(day?.events) ? day.events : null;
  }

  if (!Array.isArray(events)) {
    const empty = [];
    Object.defineProperty(empty, '__stale', { value: true, enumerable: false });
    Object.defineProperty(empty, '__fallbackReason', { value: 'thesportsdb_unavailable', enumerable: false });
    return empty;
  }
  const normalized = events.map(normalizeLive).filter(Boolean);
  cacheSet('live', normalized, TTL_LIVE);
  return normalized;
}

// Stubs idempotentes — TheSportsDB livescore não tem stats/events/lineups
// detalhados gratuitos. Retornam vazio (frontend já tolera).
async function getFixtureById(id) {
  if (!id) return [];
  const data = await httpGet(`/lookupevent.php?id=${encodeURIComponent(id)}`);
  if (!data || !Array.isArray(data.events) || !data.events[0]) return [];
  // Adapta evento agendado/encerrado (não-live) para o schema base.
  const ev = data.events[0];
  const fake = {
    idEvent: ev.idEvent,
    strHomeTeam: ev.strHomeTeam,
    strAwayTeam: ev.strAwayTeam,
    intHomeScore: ev.intHomeScore,
    intAwayScore: ev.intAwayScore,
    strLeague: ev.strLeague,
    strCountry: ev.strCountry,
    strStatus: ev.strStatus,
    strProgress: ev.strProgress,
    strVenue: ev.strVenue,
    dateEvent: ev.dateEvent,
    strTime: ev.strTime,
    idHomeTeam: ev.idHomeTeam,
    idAwayTeam: ev.idAwayTeam,
  };
  const out = normalizeLive(fake);
  return out ? [out] : [];
}

async function getFixtureStatistics() { return []; }
async function getFixtureEvents()     { return []; }
async function getFixtureLineups()    { return []; }
async function getFixturesByDate()    { return []; }
async function getFixturesByTeam()    { return []; }
async function getHeadToHead()        { return []; }
async function getPredictions()       { return []; }
async function getOdds()              { return []; }
async function getOddsLive()          { return []; }
async function getTeamStatistics()    { return null; }
async function getLeagues()           { return []; }

function isSafeMode() { return breaker.state === 'OPEN'; }
function safeMode() {
  return {
    active: breaker.state === 'OPEN',
    reason: breaker.state === 'OPEN' ? 'thesportsdb_breaker_open' : null,
    since: breaker.openedAt || null,
  };
}
function remainingRatio() { return breaker.state === 'OPEN' ? 0 : 1; }
function quota() {
  return {
    dailyLimit: null, dailyRemaining: null,
    minuteLimit: null, minuteRemaining: null,
    lastUpdated: null, lastResponseAt: null,
    provider: 'thesportsdb',
  };
}
function status() {
  return {
    provider: 'thesportsdb',
    configured: true,
    keyValid: true,
    hasKey: API_KEY !== '3',
    host: new URL(BASE_URL).host,
    baseURL: `${BASE_URL}/${API_KEY}`,
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
    if (!prefix || k.startsWith(prefix)) { cache.delete(k); n++; }
  }
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
  normalizeLive,
};
