/**
 * Robotrend IA — Bet365Data Provider (RapidAPI)
 * ============================================================
 *
 * Provider primary em produção. Consome o endpoint público:
 *   GET https://bet365data.p.rapidapi.com/live-events?sport=soccer
 *
 * Headers obrigatórios:
 *   x-rapidapi-key: <RAPIDAPI_KEY>
 *   x-rapidapi-host: bet365data.p.rapidapi.com
 *
 * Características:
 *   - cache em memória com TTL por endpoint
 *   - retry com backoff exponencial
 *   - circuit breaker (5 falhas duras → cooldown 60s)
 *   - timeout configurável (default 12s)
 *   - normalização robusta (suporta múltiplos shapes de payload)
 *   - logs `[BET365 FETCH OK]` / `[BET365 FETCH FAIL]`
 *   - interface 100% compatível com `apiFootball.js` (failover transparente)
 *
 * Shapes suportados pelo normalizer (defensivo):
 *   1. b365api padrão:  { results:[ { FI, LE, T1, T2, SS, TM, TS, TT, stats:{...} } ] }
 *   2. ad-hoc:           { events:[ { id, home_team, away_team, score, minute, league, stats } ] }
 *   3. lista direta:     [ { id, home, away, score, ... } ]
 *
 * Tudo é tolerante a campos ausentes — devolve match com `dataQuality:'partial'`
 * quando faltam stats avançadas.
 */

'use strict';

const axios = require('axios');
const { logger } = require('../logger');
const metrics = require('./metrics');

const log = logger.child({ module: 'bet365data' });

/* ============================================================
   CONFIG
   ============================================================ */
const RAPIDAPI_KEY  = String(process.env.RAPIDAPI_KEY  || '').trim();
const RAPIDAPI_HOST = String(process.env.RAPIDAPI_HOST || 'bet365data.p.rapidapi.com').trim();
const BASE_URL      = `https://${RAPIDAPI_HOST}`;

const TIMEOUT_MS  = Number(process.env.BET365_TIMEOUT_MS  || 12_000);
const RETRY_MAX   = Number(process.env.BET365_RETRY_MAX   || 3);
const RETRY_DELAY = Number(process.env.BET365_RETRY_DELAY_MS || 800);

const TTL_LIVE      = Number(process.env.BET365_TTL_LIVE_MS      || 12_000);
const TTL_DETAILS   = Number(process.env.BET365_TTL_DETAILS_MS   || 30_000);
const TTL_STATS     = Number(process.env.BET365_TTL_STATS_MS     || 15_000);
const TTL_EVENTS    = Number(process.env.BET365_TTL_EVENTS_MS    || 15_000);
const TTL_ODDS      = Number(process.env.BET365_TTL_ODDS_MS      || 30_000);

const CB_THRESHOLD = Number(process.env.BET365_CB_THRESHOLD  || 5);
const CB_COOLDOWN  = Number(process.env.BET365_CB_COOLDOWN_MS || 60_000);

const VERBOSE      = String(process.env.BET365_VERBOSE || 'false').toLowerCase() === 'true';

/* ============================================================
   MÉTRICAS
   ============================================================ */
const m_calls     = metrics.counter('bet365_calls_total',     'Chamadas ao endpoint bet365data');
const m_errors    = metrics.counter('bet365_errors_total',    'Erros (4xx/5xx/rede)');
const m_retries   = metrics.counter('bet365_retries_total');
const m_cache_hit = metrics.counter('bet365_cache_hit_total');
const m_cache_miss = metrics.counter('bet365_cache_miss_total');
const g_breaker   = metrics.gauge('bet365_breaker_open',  '1 quando breaker está aberto');
const g_quota     = metrics.gauge('bet365_quota_remaining', 'X-RateLimit-Requests-Remaining');

/* ============================================================
   AXIOS CLIENT — único, com headers RapidAPI fixos
   ============================================================ */
const client = axios.create({
  baseURL: BASE_URL,
  timeout: TIMEOUT_MS,
  headers: {
    'x-rapidapi-key':  RAPIDAPI_KEY,
    'x-rapidapi-host': RAPIDAPI_HOST,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  },
  decompress: true,
  validateStatus: (s) => s >= 200 && s < 500,
});

/* ============================================================
   CACHE em memória
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
  if (cache.size > 1000) {
    const now = Date.now();
    for (const [k, v] of cache) if (v.expiresAt < now) cache.delete(k);
  }
}

/* ============================================================
   CIRCUIT BREAKER
   ============================================================ */
const breaker = {
  state: 'CLOSED',
  failures: 0,
  openedAt: 0,
  lastError: null,
  totals: { exec: 0, fail: 0, shortCircuit: 0 },
  snapshot() {
    return {
      name: 'bet365data',
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
    console.log('[BREAKER CLOSED] bet365data breaker resetado após cooldown');
    return true;
  }
  breaker.totals.shortCircuit++;
  return false;
}

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
      console.log('[BREAKER CLOSED] bet365data recuperado após', breaker.failures, 'falhas');
    }
    breaker.failures = 0;
    if (breaker.state !== 'CLOSED') {
      breaker.state = 'CLOSED';
      g_breaker.set(0);
    }
    return;
  }
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
    console.warn('[BREAKER OPEN] bet365data — ' + breaker.failures + ' falhas duras consecutivas');
  }
}

/* ============================================================
   HTTP GET com retry/backoff e breaker
   ============================================================ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpGet(path, params = {}) {
  if (!isConfigured()) {
    const err = new Error('bet365data: RAPIDAPI_KEY ausente');
    err.code = 'BET365_NO_KEY';
    throw err;
  }
  if (!breakerAllow()) {
    const err = new Error('bet365data: circuit breaker OPEN');
    err.code = 'CIRCUIT_OPEN';
    throw err;
  }

  breaker.totals.exec++;
  let lastErr;

  for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
    const t0 = Date.now();
    try {
      m_calls.inc();
      const resp = await client.get(path, { params });

      // Quota da RapidAPI
      const remaining = Number(resp.headers?.['x-ratelimit-requests-remaining']);
      if (Number.isFinite(remaining)) g_quota.set(remaining);

      if (resp.status === 401 || resp.status === 403) {
        const err = new Error(`bet365data: ${resp.status} — chave RapidAPI inválida ou sem permissão`);
        err.status = resp.status;
        err.code = 'BET365_AUTH';
        m_errors.inc({ status: String(resp.status) });
        breakerRecord(false, err);
        throw err;
      }
      if (resp.status === 429) {
        const err = new Error('bet365data: 429 rate-limited');
        err.status = 429;
        err.code = 'BET365_RATELIMIT';
        m_errors.inc({ status: '429' });
        breakerRecord(false, err);
        throw err;
      }
      if (resp.status >= 400) {
        const err = new Error(`bet365data: HTTP ${resp.status}`);
        err.status = resp.status;
        err.body = resp.data;
        m_errors.inc({ status: String(resp.status) });
        if (attempt < RETRY_MAX && resp.status >= 500) {
          m_retries.inc();
          await sleep(RETRY_DELAY * Math.pow(2, attempt));
          lastErr = err;
          continue;
        }
        breakerRecord(false, err);
        throw err;
      }

      if (VERBOSE) {
        console.log(`[BET365 FETCH OK] ${path} status=${resp.status} t=${Date.now() - t0}ms quota=${remaining ?? '?'}`);
      }
      breakerRecord(true);
      return resp.data;
    } catch (err) {
      lastErr = err;
      m_errors.inc({ code: err.code || 'unknown' });
      const transient = isTransientError(err);
      if (transient && attempt < RETRY_MAX) {
        m_retries.inc();
        const wait = RETRY_DELAY * Math.pow(2, attempt);
        console.warn(`[BET365 FETCH RETRY] ${path} attempt=${attempt + 1}/${RETRY_MAX} wait=${wait}ms err=${err.code || err.message}`);
        await sleep(wait);
        continue;
      }
      breakerRecord(false, err);
      console.warn(`[BET365 FETCH FAIL] ${path} ${err.code || ''} ${err.message}`);
      throw err;
    }
  }
  throw lastErr;
}

/* ============================================================
   NORMALIZAÇÃO — adapta payload bruto para o schema do projeto
   ============================================================ */

/** Pega o primeiro valor truthy entre várias chaves possíveis. */
function pick(obj, ...keys) {
  if (!obj) return undefined;
  for (const k of keys) {
    if (obj[k] != null && obj[k] !== '') return obj[k];
  }
  return undefined;
}

/** Extrai a lista de fixtures de qualquer wrapper razoável. */
function extractList(body) {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  // b365api: { success:1, results:[...] }
  if (Array.isArray(body.results)) return body.results;
  // ad-hoc: { events:[...] } / { data:[...] } / { live_events:[...] } / { matches:[...] }
  for (const k of ['events', 'data', 'live_events', 'matches', 'fixtures', 'items']) {
    if (Array.isArray(body[k])) return body[k];
  }
  // Objeto único — embrulha como lista de 1
  if (typeof body === 'object' && (body.id || body.FI || body.fi || body.home || body.T1)) return [body];
  return [];
}

/** Converte "1-0" / "1:0" / [1,0] → { home, away }. */
function parseScore(raw) {
  if (raw == null) return { home: 0, away: 0 };
  if (Array.isArray(raw)) {
    return { home: Number(raw[0] || 0), away: Number(raw[1] || 0) };
  }
  const s = String(raw).trim();
  const m = s.match(/^(\d+)\s*[-:]\s*(\d+)/);
  if (!m) return { home: 0, away: 0 };
  return { home: Number(m[1]), away: Number(m[2]) };
}

/** "3-2" para Corners/Cards → { home, away }. Aceita também { home, away } direto. */
function parsePair(raw, defaultVal = 0) {
  if (raw == null) return { home: defaultVal, away: defaultVal };
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return {
      home: Number(pick(raw, 'home', 'h', 'H', '0') ?? defaultVal),
      away: Number(pick(raw, 'away', 'a', 'A', '1') ?? defaultVal),
    };
  }
  return parseScore(raw);
}

/**
 * Bet365 status mapping (b365api shape):
 *   TT = "1" (1H), "2" (2H), "HT", "FT", "ET", "PEN"
 *   time_status = "0" not started | "1" live | "2" over | "3" postponed
 */
function mapStatus(raw) {
  const tt = String(pick(raw, 'TT', 'tt', 'period', 'half') || '').toUpperCase();
  const ts = String(pick(raw, 'time_status', 'TS_STATUS', 'status') || '').toUpperCase();

  if (tt === 'HT') return { short: 'HT', long: 'Halftime', isLive: true,  isFinished: false };
  if (tt === 'FT' || ts === '3' || ts === 'FT' || ts === 'FINISHED') {
    return { short: 'FT', long: 'Finished', isLive: false, isFinished: true };
  }
  if (tt === 'ET') return { short: 'ET', long: 'Extra Time', isLive: true, isFinished: false };
  if (tt === 'PEN') return { short: 'P', long: 'Penalty', isLive: true, isFinished: false };
  if (tt === '1' || tt === '1H') return { short: '1H', long: '1st Half', isLive: true, isFinished: false };
  if (tt === '2' || tt === '2H') return { short: '2H', long: '2nd Half', isLive: true, isFinished: false };

  if (ts === '1' || ts === 'LIVE' || ts === 'INPROGRESS') {
    return { short: '2H', long: 'In Progress', isLive: true, isFinished: false };
  }
  if (ts === '0' || ts === 'NS') {
    return { short: 'NS', long: 'Not Started', isLive: false, isFinished: false };
  }
  // Default conservador — se há placar/minuto, assume live; senão NS
  const min = Number(pick(raw, 'TM', 'tm', 'minute', 'time') || 0);
  if (min > 0) return { short: '2H', long: 'In Progress', isLive: true, isFinished: false };
  return { short: 'NS', long: 'Not Started', isLive: false, isFinished: false };
}

/** Time/clube — extrai { id, name, logo }. */
function pickTeam(raw, side /* 'home' | 'away' */) {
  // Estruturas comuns: T1/T2, home/away (obj), home_team/away_team (string)
  if (side === 'home') {
    const obj = pick(raw, 'home', 'T1_obj') || (typeof raw.T1 === 'object' ? raw.T1 : null);
    if (obj && typeof obj === 'object') {
      return {
        id:   pick(obj, 'id', 'ID', 'team_id') || null,
        name: pick(obj, 'name', 'NA', 'team') || 'Home',
        logo: pick(obj, 'logo', 'image_id') || null,
      };
    }
    return {
      id:   pick(raw, 'home_id', 'home_team_id', 'T1_id') || null,
      name: pick(raw, 'home_team', 'home_name', 'T1', 'home') || 'Home',
      logo: pick(raw, 'home_logo', 'home_image') || null,
    };
  }
  const obj = pick(raw, 'away', 'T2_obj') || (typeof raw.T2 === 'object' ? raw.T2 : null);
  if (obj && typeof obj === 'object') {
    return {
      id:   pick(obj, 'id', 'ID', 'team_id') || null,
      name: pick(obj, 'name', 'NA', 'team') || 'Away',
      logo: pick(obj, 'logo', 'image_id') || null,
    };
  }
  return {
    id:   pick(raw, 'away_id', 'away_team_id', 'T2_id') || null,
    name: pick(raw, 'away_team', 'away_name', 'T2', 'away') || 'Away',
    logo: pick(raw, 'away_logo', 'away_image') || null,
  };
}

function pickLeague(raw) {
  const leagueObj = pick(raw, 'league', 'LEAGUE', 'competition', 'tournament');
  if (leagueObj && typeof leagueObj === 'object') {
    return {
      id:      pick(leagueObj, 'id', 'ID', 'league_id') || null,
      name:    pick(leagueObj, 'name', 'NA', 'league') || 'Unknown',
      country: pick(leagueObj, 'country', 'cc', 'CC') || 'World',
      logo:    pick(leagueObj, 'logo', 'image_id') || null,
      flag:    pick(leagueObj, 'flag') || null,
      season:  pick(leagueObj, 'season', 'year') || null,
      round:   pick(leagueObj, 'round') || null,
    };
  }
  const leagueStr = pick(raw, 'LE', 'league_name', 'tournament_name') || 'Unknown';
  return {
    id: pick(raw, 'league_id', 'LE_ID') || null,
    name: leagueStr,
    country: pick(raw, 'country', 'cc') || 'World',
    logo: null,
    flag: null,
    season: null,
    round: null,
  };
}

/** Minuto da partida (TM) — bet365 também pode mandar TT='HT' com TM=45. */
function pickMinute(raw, statusShort) {
  if (statusShort === 'HT') return 45;
  if (statusShort === 'FT') return 90;
  const min = Number(pick(raw, 'TM', 'tm', 'minute', 'time', 'elapsed') || 0);
  return Number.isFinite(min) && min > 0 ? min : 0;
}

/** Extrai stats (corners, cards, shots) de qualquer subshape. */
function extractStats(raw) {
  // shape 1: raw.stats = { corners: "3-2", yellowcards: "1-0", ... }
  // shape 2: raw.stats.corners = { home: 3, away: 2 }
  // shape 3: raw.corners = "3-2"  ou raw.corners = [3,2]
  const sNode = raw.stats || raw.statistics || raw;
  const corners      = parsePair(pick(sNode, 'corners', 'corner_kicks', 'CO'));
  const yellowCards  = parsePair(pick(sNode, 'yellowcards', 'yellow_cards', 'YC'));
  const redCards     = parsePair(pick(sNode, 'redcards', 'red_cards', 'RC'));
  const shotsOnTarget = parsePair(pick(sNode, 'shots_on_target', 'shotsOnGoal', 'OT'));
  const shotsOff      = parsePair(pick(sNode, 'shots_off_target', 'shotsOffGoal', 'OFT'));
  const totalShots    = parsePair(pick(sNode, 'shots', 'total_shots'));
  const attacks       = parsePair(pick(sNode, 'attacks', 'AT'));
  const dangerous     = parsePair(pick(sNode, 'dangerous_attacks', 'dangerousAttacks', 'DA'));
  const possession    = parsePair(pick(sNode, 'possession_rt', 'possession', 'ball_possession'), 50);
  const goalAttempts  = parsePair(pick(sNode, 'goal_attempts'));

  return {
    corners,
    yellowCards,
    redCards,
    shotsOnTarget,
    shotsOff,
    totalShots: {
      home: totalShots.home || (shotsOnTarget.home + shotsOff.home),
      away: totalShots.away || (shotsOnTarget.away + shotsOff.away),
    },
    attacks,
    dangerousAttacks: dangerous,
    possession,
    goalAttempts,
  };
}

/** Eventos timeline (gols/cartões) — se vierem no payload. */
function extractTimeline(raw) {
  const ev = pick(raw, 'events', 'timeline', 'incidents') || [];
  if (!Array.isArray(ev)) return [];
  return ev.map((e) => ({
    time: { elapsed: Number(pick(e, 'minute', 'min', 'TM') || 0), extra: pick(e, 'extra', 'addedTime') || null },
    team: { id: pick(e, 'team_id', 'team') || null, name: pick(e, 'team_name', 'team') || null },
    type:   String(pick(e, 'type', 'event_type') || '').toLowerCase(),
    detail: String(pick(e, 'detail', 'sub_type') || ''),
    player: pick(e, 'player', 'scorer', 'player_name') || null,
    assist: pick(e, 'assist', 'assist_name') || null,
    raw: e,
  }));
}

/**
 * Odds line — bet365 envia em `ma[]` (main markets), shape:
 *   ma: [
 *     { id, na: "Match Result"/"Full Time Result", sp: [{ na:"1", od:"2.50" }, ...] },
 *     { id, na: "Goals Over/Under", sp: [{ na:"Over 2.5", od:"1.85" }, ...] },
 *     { id, na: "Both Teams to Score", sp: [{ na:"Yes", od:"1.70" }, ...] }
 *   ]
 *
 * Também tolera shapes alternativos (`odds`, `markets`, decimal flat).
 */
function parseDecimal(v) {
  if (v == null) return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) && n > 1 ? n : null;
}

function extractMarkets(maArr) {
  if (!Array.isArray(maArr)) return null;
  const out = {};
  for (const m of maArr) {
    const name = String(m?.na || m?.name || '').toLowerCase();
    const selections = m?.sp || m?.selections || m?.outcomes || [];
    if (!Array.isArray(selections) || !selections.length) continue;

    // 1X2 / Match Result / Full Time Result
    if (/(match result|full time result|1x2|moneyline|winner)/i.test(name)) {
      for (const s of selections) {
        const sel = String(s?.na || s?.name || '').toLowerCase().trim();
        const od  = parseDecimal(s?.od || s?.odd || s?.price);
        if (!od) continue;
        if (sel === '1' || /home/.test(sel)) out.home = od;
        else if (sel === '2' || /away/.test(sel)) out.away = od;
        else if (sel === 'x' || /draw/.test(sel)) out.draw = od;
      }
    }
    // Over/Under 2.5
    else if (/over\/under|goals.*o\/u|total goals/i.test(name)) {
      for (const s of selections) {
        const sel = String(s?.na || s?.name || '').toLowerCase().trim();
        const od  = parseDecimal(s?.od || s?.odd || s?.price);
        if (!od) continue;
        if (/over\s*2\.5/.test(sel))  out.over25  = od;
        if (/under\s*2\.5/.test(sel)) out.under25 = od;
        if (/over\s*1\.5/.test(sel))  out.over15  = od;
        if (/under\s*1\.5/.test(sel)) out.under15 = od;
        if (/over\s*3\.5/.test(sel))  out.over35  = od;
        if (/under\s*3\.5/.test(sel)) out.under35 = od;
      }
    }
    // BTTS
    else if (/both teams|btts/i.test(name)) {
      for (const s of selections) {
        const sel = String(s?.na || s?.name || '').toLowerCase().trim();
        const od  = parseDecimal(s?.od || s?.odd || s?.price);
        if (!od) continue;
        if (/yes/.test(sel)) out.bttsYes = od;
        if (/no/.test(sel))  out.bttsNo  = od;
      }
    }
    // Corners (Asian / Total)
    else if (/corner/i.test(name)) {
      for (const s of selections) {
        const sel = String(s?.na || s?.name || '').toLowerCase().trim();
        const od  = parseDecimal(s?.od || s?.odd || s?.price);
        if (!od) continue;
        if (/over\s*9\.5/.test(sel))  out.cornersOver95  = od;
        if (/under\s*9\.5/.test(sel)) out.cornersUnder95 = od;
      }
    }
  }
  return Object.keys(out).length ? out : null;
}

function extractOdds(raw) {
  // shape 1 (bet365 oficial): raw.ma = [ { na, sp:[{na,od}] }, ... ]
  const fromMa = extractMarkets(pick(raw, 'ma', 'MA'));
  if (fromMa) return fromMa;

  // shape 2: raw.odds = { home, draw, away, over_25, ... }
  const odds = pick(raw, 'odds', 'markets') || null;
  if (!odds) return null;
  if (Array.isArray(odds)) {
    const fromArr = extractMarkets(odds);
    if (fromArr) return fromArr;
    return odds;
  }
  if (typeof odds === 'object') {
    return {
      home: parseDecimal(pick(odds, 'home', 'H', '1')),
      draw: parseDecimal(pick(odds, 'draw', 'D', 'X')),
      away: parseDecimal(pick(odds, 'away', 'A', '2')),
      over25:  parseDecimal(pick(odds, 'over_25', 'over25', 'O25')),
      under25: parseDecimal(pick(odds, 'under_25', 'under25', 'U25')),
      bttsYes: parseDecimal(pick(odds, 'btts_yes', 'BTTS_Y')),
      bttsNo:  parseDecimal(pick(odds, 'btts_no',  'BTTS_N')),
    };
  }
  return null;
}

/** Normaliza UM fixture cru → schema canônico do projeto. */
function normalizeMatch(raw, idx = 0) {
  if (!raw || typeof raw !== 'object') return null;

  const id = String(pick(raw, 'FI', 'fi', 'id', 'ID', 'event_id', 'fixture_id') || `b365-${idx}-${Date.now()}`);
  const status = mapStatus(raw);
  const minute = pickMinute(raw, status.short);
  const score  = parseScore(pick(raw, 'SS', 'ss', 'score', 'current_score'));
  const home   = pickTeam(raw, 'home');
  const away   = pickTeam(raw, 'away');
  const league = pickLeague(raw);
  const stats  = extractStats(raw);
  const events = extractTimeline(raw);
  const odds   = extractOdds(raw);

  // Kickoff — bet365 às vezes manda `time_start` em UNIX ou ISO
  const tsRaw = pick(raw, 'TU', 'time_start', 'kickoff', 'startsAt', 'start_time');
  let kickoffAt;
  if (tsRaw) {
    const n = Number(tsRaw);
    kickoffAt = Number.isFinite(n) && n > 1_000_000_000 ? new Date(n * 1000).toISOString()
              : new Date(tsRaw).toISOString();
  } else if (minute > 0) {
    kickoffAt = new Date(Date.now() - minute * 60_000).toISOString();
  } else {
    kickoffAt = new Date().toISOString();
  }

  // Momentum/pressure aproximados a partir de dangerous attacks (assim como Sofascore)
  const totalDanger = (stats.dangerousAttacks.home + stats.dangerousAttacks.away) || 1;
  const pressureHome = Math.round((stats.dangerousAttacks.home / totalDanger) * 100);
  const pressureAway = 100 - pressureHome;

  return {
    id,
    fixtureId: id,
    league,
    teams: { home, away },
    home: home.name,
    away: away.name,
    minute,
    status: status.short,
    statusLong: status.long,
    venue: pick(raw, 'venue', 'stadium') || null,
    kickoffAt,
    date: kickoffAt,
    score: {
      home: score.home,
      away: score.away,
      ht: null,
      ft: status.isFinished ? { home: score.home, away: score.away } : null,
      halftime: null,
      fulltime: status.isFinished ? { home: score.home, away: score.away } : null,
    },
    corners: stats.corners,
    cards: { yellow: stats.yellowCards, red: stats.redCards },
    shots: stats.totalShots,
    shotsOnTarget: stats.shotsOnTarget,
    attacks: stats.attacks,
    dangerousAttacks: stats.dangerousAttacks,
    possession: stats.possession,
    pressure: { home: pressureHome, away: pressureAway },
    momentum: pressureHome > 60 ? 'home' : pressureAway > 60 ? 'away' : 'balanced',
    odds,
    stats: null,           // shape API-Sports (preenchido por enricher se chamar getFixtureStatistics)
    perMinute: null,
    events,                // timeline crua
    enriched: false,
    enrichedAt: null,
    flags: {
      isLive: status.isLive,
      isFinished: status.isFinished,
      isFromLiveAPI: true,
      source: 'bet365data',
    },
    isLive: status.isLive,
    isFromLiveAPI: true,
    source: 'bet365data',
    provider: 'bet365data',
    dataQuality: 'full',
    lastApiUpdate: Date.now(),
    // SHADOW shape API-Sports — compat com prelive/live/consensus
    fixture: {
      id,
      date: kickoffAt,
      status: { short: status.short, long: status.long, elapsed: minute },
      venue: { name: pick(raw, 'venue', 'stadium') || null, city: null },
      referee: pick(raw, 'referee') || null,
    },
    goals: { home: score.home, away: score.away },
  };
}

/* ============================================================
   STATS ADAPTER (Bet365 → shape API-Sports usado pelo enricher)
   ============================================================ */
const BET365_TO_APISPORTS = [
  ['corners',           'Corner Kicks'],
  ['yellowCards',       'Yellow Cards'],
  ['redCards',          'Red Cards'],
  ['totalShots',        'Total Shots'],
  ['shotsOnTarget',     'Shots on Goal'],
  ['shotsOff',          'Shots off Goal'],
  ['attacks',           'Attacks'],
  ['dangerousAttacks',  'Dangerous Attacks'],
  ['possession',        'Ball Possession'],
  ['goalAttempts',      'Goal Attempts'],
];

function adaptStatsToApiSports(rawMatch) {
  const stats = extractStats(rawMatch);
  const home = pickTeam(rawMatch, 'home');
  const away = pickTeam(rawMatch, 'away');
  const homeArr = [];
  const awayArr = [];
  for (const [key, type] of BET365_TO_APISPORTS) {
    const v = stats[key];
    if (!v) continue;
    homeArr.push({ type, value: v.home });
    awayArr.push({ type, value: v.away });
  }
  return [
    { team: { id: home.id || 'home' }, statistics: homeArr },
    { team: { id: away.id || 'away' }, statistics: awayArr },
  ];
}

/* ============================================================
   PUBLIC API — interface compatível com `apiFootball.js`
   ============================================================ */

function isConfigured() {
  return !!RAPIDAPI_KEY;
}

/** Lista de fixtures live, normalizadas. */
async function getLiveFixtures(_opts = {}) {
  const cached = cacheGet('live');
  if (cached) return cached;

  let data;
  try {
    data = await httpGet('/live-events', { sport: 'soccer' });
  } catch (e) {
    const empty = [];
    Object.defineProperty(empty, '__stale', { value: true, enumerable: false });
    Object.defineProperty(empty, '__fallbackReason', { value: 'bet365_unavailable:' + (e.code || 'error'), enumerable: false });
    return empty;
  }

  const list = extractList(data);
  if (!list.length) {
    if (VERBOSE) console.warn('[BET365 FETCH OK] payload vazio (0 fixtures)');
    const empty = [];
    Object.defineProperty(empty, '__stale', { value: true, enumerable: false });
    Object.defineProperty(empty, '__fallbackReason', { value: 'bet365_empty_payload', enumerable: false });
    return empty;
  }

  const normalized = list
    .map((raw, idx) => {
      try { return normalizeMatch(raw, idx); }
      catch (e) {
        console.warn('[BET365 NORMALIZE] falhou para fixture idx=' + idx + ': ' + e.message);
        return null;
      }
    })
    .filter((m) => m && m.flags.isLive);

  console.log(`[BET365 FETCH OK] matches: ${normalized.length} / total payload: ${list.length}`);
  cacheSet('live', normalized, TTL_LIVE);
  return normalized;
}

async function getFixtureById(id) {
  if (!id) return [];
  // bet365data não expõe endpoint /event/:id padrão — buscamos no cache live.
  const live = await getLiveFixtures();
  const found = live.find((m) => String(m.id) === String(id));
  return found ? [found] : [];
}

async function getFixtureStatistics(id) {
  if (!id) return [];
  const key = `stats:${id}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const live = await getLiveFixtures();
  const match = live.find((m) => String(m.id) === String(id));
  if (!match) return [];
  // Re-extrai do raw (caso o payload original esteja no cache — devolvemos
  // o adapter aplicado sobre o próprio objeto normalizado).
  const adapted = adaptStatsToApiSports(match);
  cacheSet(key, adapted, TTL_STATS);
  return adapted;
}

async function getFixtureEvents(id) {
  if (!id) return [];
  const key = `events:${id}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const live = await getLiveFixtures();
  const match = live.find((m) => String(m.id) === String(id));
  const events = match?.events || [];
  cacheSet(key, events, TTL_EVENTS);
  return events;
}

async function getFixtureLineups() { return []; }
async function getFixturesByDate() { return []; }      // bet365data foca em live
async function getFixturesByTeam() { return []; }
async function getHeadToHead()    { return []; }
async function getPredictions()   { return []; }
async function getTeamStatistics(){ return null; }
async function getLeagues()       { return []; }

async function getOdds({ fixture } = {}) {
  if (!fixture) return [];
  const live = await getLiveFixtures();
  const m = live.find((x) => String(x.id) === String(fixture));
  if (!m?.odds) return [];
  return Array.isArray(m.odds) ? m.odds : [m.odds];
}
async function getOddsLive(arg) { return getOdds(arg); }

/* ============================================================
   SAFE-MODE / QUOTA
   ============================================================ */
function isSafeMode() { return breaker.state === 'OPEN'; }
function safeMode() {
  return {
    active: breaker.state === 'OPEN',
    reason: breaker.state === 'OPEN' ? 'bet365_breaker_open' : null,
    since: breaker.openedAt || null,
  };
}
function remainingRatio() { return breaker.state === 'OPEN' ? 0 : 1; }
function quota() {
  return {
    dailyLimit: null,
    dailyRemaining: null,
    minuteLimit: null,
    minuteRemaining: null,
    lastUpdated: null,
    lastResponseAt: null,
    provider: 'bet365data',
  };
}

function status() {
  return {
    provider: 'bet365data',
    configured: isConfigured(),
    keyValid: isConfigured(),
    hasKey: isConfigured(),
    host: RAPIDAPI_HOST,
    baseURL: BASE_URL,
    baseURLs: [BASE_URL],
    legacyRapidApi: true,
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

/* ============================================================
   EXPORT — interface compatível com apiFootball.js
   ============================================================ */
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
  // utilitários internos exportados para testes
  normalizeMatch,
  extractList,
  extractStats,
  adaptStatsToApiSports,
  parseScore,
  parsePair,
  mapStatus,
};
