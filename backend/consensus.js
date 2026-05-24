/**
 * Robotrend IA — Multi-API Consensus Engine
 *
 * Confirma que um match está LIVE em N fontes externas independentes
 * antes de qualquer análise ou emissão de sinal.
 *
 * Fontes possíveis (todas com retry exponencial):
 *   1. STATUS   → API-Football v3/fixtures?live=all
 *   2. EVENTS   → API-Football v3/fixtures?live=all (filtra elapsed >= 1 e events ativos)
 *   3. ODDS     → The Odds API v4/sports/soccer/odds  ── OPCIONAL ──
 *
 * Modo ODDS opcional (default quando ODDS_API_KEY ausente OU ODDS_OPTIONAL=true):
 *   - Source "odds" é desativada no boot (não há request nem retry)
 *   - Warning emitido UMA vez, sem spam
 *   - Consenso passa a ser de 2 fontes (status + events) — API-Football só
 *   - Realtime, signals e fixtures continuam fluindo normalmente
 *
 * Modo estrito (ODDS_API_KEY presente E ODDS_OPTIONAL=false):
 *   - As 3 fontes precisam concordar
 *   - Qualquer fonte falhando → bloqueia todos os matches do ciclo
 *
 * Regras compartilhadas:
 *   - Diferença máxima de timestamp entre fontes: 60s (configurável)
 *   - Em STRICT_REAL_ONLY=false (dev) o engine é bypass (devolve a lista intacta)
 *
 * Logs:
 *   [CONSENSUS]            X/Y matches confirmados pelas N APIs
 *   [CONSENSUS DIVERGENCE] match divergiu (reason)
 *   [CONSENSUS RETRY]      tentativa X/Y falhou
 *   [CONSENSUS FAIL]       source "name" indisponível
 *   [CONSENSUS BLOCK]      bloqueando TODOS os matches
 *   [CONSENSUS ODDS]       odds desativadas — modo fallback (somente 1x)
 */

'use strict';

const axios = require('axios');
const apiFootball = require('./services/apiFootball');

const ENV = process.env.NODE_ENV || 'development';
const STRICT_REAL_ONLY = (() => {
  const raw = process.env.STRICT_REAL_ONLY;
  if (raw == null || raw === '') return ENV === 'production' || ENV === 'staging';
  return String(raw).toLowerCase() === 'true';
})();

// Retries default rebaixado para 1: apiFootball já faz retry interno
// com backoff exponencial, então retentar aqui só gerava 3x mais log
// de falha e quase nunca novas chamadas (cache/in-flight dedup).
const RETRIES            = Number(process.env.CONSENSUS_RETRIES            || 1);
const RETRY_DELAY_MS     = Number(process.env.CONSENSUS_RETRY_DELAY_MS     || 1_000);
const TS_TOLERANCE_MS    = Number(process.env.CONSENSUS_TS_TOLERANCE_MS    || 60_000);
const FETCH_TIMEOUT_MS   = Number(process.env.CONSENSUS_FETCH_TIMEOUT_MS   || 10_000);

const API_FOOTBALL_KEY  = process.env.API_FOOTBALL_KEY;
const API_FOOTBALL_HOST = process.env.API_FOOTBALL_HOST || 'api-football-v1.p.rapidapi.com';
const ODDS_API_KEY      = (process.env.ODDS_API_KEY || '').trim();

/* ============================================================
   ODDS opcional — flag explícita OU ausência de chave equivale a "opcional"
   ============================================================ */
const ODDS_OPTIONAL = (() => {
  const raw = process.env.ODDS_OPTIONAL;
  if (raw == null || raw === '') return !ODDS_API_KEY; // sem chave → opcional por padrão
  return String(raw).toLowerCase() === 'true';
})();
const ODDS_ENABLED = !!ODDS_API_KEY && !ODDS_OPTIONAL;

// Source list efetivo (recalculado conforme ODDS_ENABLED)
const SOURCE_NAMES = ODDS_ENABLED ? ['status', 'events', 'odds'] : ['status', 'events'];

// Warning único no boot
if (!ODDS_ENABLED) {
  const reason = !ODDS_API_KEY ? 'ODDS_API_KEY ausente' : 'ODDS_OPTIONAL=true';
  console.warn(`[CONSENSUS ODDS] modo fallback ativo (${reason}) — usando apenas API-Football (${SOURCE_NAMES.join('+')}). Matches NÃO serão bloqueados por ausência de odds.`);
}

/* ============================================================
   HELPERS
   ============================================================ */
function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function matchKey(m) {
  return `${normalize(m?.home)}__vs__${normalize(m?.away)}`;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function withRetry(name, fn, retries = RETRIES, baseDelay = RETRY_DELAY_MS) {
  let lastErr;
  for (let i = 1; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      console.warn(`[CONSENSUS RETRY] ${name} tentativa ${i}/${retries} falhou: ${e.message}`);
      if (i < retries) await sleep(baseDelay * i);
    }
  }
  throw new Error(`${name} falhou após ${retries} tentativas: ${lastErr?.message || 'unknown'}`);
}

/* ============================================================
   SOURCE ADAPTERS
   Cada um retorna um Map<matchKey, { status, timestamp, raw }>
   ============================================================ */
async function fetchStatusSource() {
  if (!API_FOOTBALL_KEY) throw new Error('API_FOOTBALL_KEY ausente (status)');
  // Reusa o cache/quota do serviço centralizado (chamada compartilhada
  // com events e com live.js — o dedup in-flight garante 1 round-trip).
  const response = await apiFootball.getLiveFixtures();
  const out = new Map();
  for (const fx of response || []) {
    const status = fx?.fixture?.status?.short;
    if (!status) continue;
    const kickoff = new Date(fx.fixture.date).getTime();
    const elapsedMs = (fx.fixture.status.elapsed || 0) * 60_000;
    const ts = Number.isFinite(kickoff) ? kickoff + elapsedMs : Date.now();
    out.set(matchKey({ home: fx.teams.home.name, away: fx.teams.away.name }),
      { status, timestamp: ts, raw: { fixtureId: fx.fixture.id } });
  }
  return out;
}

async function fetchEventsSource() {
  if (!API_FOOTBALL_KEY) throw new Error('API_FOOTBALL_KEY ausente (events)');
  const response = await apiFootball.getLiveFixtures();
  const out = new Map();
  for (const fx of response || []) {
    const elapsed = fx?.fixture?.status?.elapsed;
    if (!elapsed || elapsed < 1) continue; // sem progressão = não confirmado pela feed de eventos
    out.set(matchKey({ home: fx.teams.home.name, away: fx.teams.away.name }),
      { status: 'live', timestamp: Date.now(), raw: { elapsed } });
  }
  return out;
}

async function fetchOddsSource() {
  if (!ODDS_API_KEY) throw new Error('ODDS_API_KEY ausente');
  const { data } = await axios.get(
    `https://api.the-odds-api.com/v4/sports/soccer/odds?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h&oddsFormat=decimal`,
    { timeout: FETCH_TIMEOUT_MS }
  );
  const out = new Map();
  const now = Date.now();
  for (const game of data || []) {
    const ts = new Date(game.commence_time).getTime();
    if (!Number.isFinite(ts)) continue;
    if (ts > now) continue;                       // ainda não começou
    if (now - ts > 4 * 3_600_000) continue;        // já passou da janela live
    out.set(matchKey({ home: game.home_team, away: game.away_team }),
      { status: 'live', timestamp: ts, raw: { oddsId: game.id } });
  }
  return out;
}

const DEFAULT_SOURCES = {
  status: fetchStatusSource,
  events: fetchEventsSource,
  odds:   fetchOddsSource,
};

/* ============================================================
   FETCH ALL SOURCES (paralelo, com retry por source)

   Em modo fallback (ODDS_ENABLED=false) a source "odds" NUNCA é chamada,
   mesmo que o caller passe um `sources` customizado contendo ela. Isso evita:
     - request HTTP desnecessária
     - retry loop de 3x falhando + sleep (~3s desperdiçados por ciclo)
     - log de "[CONSENSUS FAIL] odds indisponível" repetindo
   ============================================================ */
async function fetchAllSources(sources = DEFAULT_SOURCES) {
  const activeNames = SOURCE_NAMES.filter((n) => n !== 'odds' || ODDS_ENABLED);
  const entries = await Promise.all(
    activeNames.map(async (name) => {
      const fn = sources[name];
      if (typeof fn !== 'function') return [name, { ok: false, error: 'source não configurada' }];
      try {
        const data = await withRetry(name, fn);
        return [name, { ok: true, data }];
      } catch (e) {
        console.error(`[CONSENSUS FAIL] source "${name}" indisponível: ${e.message}`);
        return [name, { ok: false, error: e.message }];
      }
    })
  );
  return Object.fromEntries(entries);
}

/* ============================================================
   CONFIRM MATCHES (consensus)
   ============================================================ */
async function confirmMatches(matches, opts = {}) {
  const strict = opts.strict != null ? !!opts.strict : STRICT_REAL_ONLY;
  if (!strict) {
    return { confirmed: matches || [], divergences: [], failedSources: [] };
  }
  if (!Array.isArray(matches) || matches.length === 0) {
    return { confirmed: [], divergences: [], failedSources: [] };
  }

  // SAFE-MODE: o engine de consenso dispara 2-3 chamadas adicionais por ciclo.
  // Em quota baixa, confiamos no poller central (single owner) e devolvemos
  // os matches sem confirmação extra.
  if (apiFootball.isSafeMode && apiFootball.isSafeMode()) {
    return {
      confirmed: matches.map((m) => ({
        ...m,
        consensus: { confirmedAt: Date.now(), sources: ['poller-cache'], safeMode: true },
      })),
      divergences: [],
      failedSources: [],
    };
  }

  const sources = await fetchAllSources(opts.sources || DEFAULT_SOURCES);
  // Considera só as fontes efetivamente ativas (odds pode estar desligada)
  const activeNames = SOURCE_NAMES.filter((n) => sources[n] != null);
  const failedSources = activeNames.filter((n) => !sources[n]?.ok);
  if (failedSources.length) {
    console.error(
      `[CONSENSUS BLOCK] sources falharam: ${failedSources.join(',')} → bloqueando ${matches.length} matches`
    );
    return { confirmed: [], divergences: [], failedSources };
  }

  const confirmed = [];
  const divergences = [];

  for (const m of matches) {
    const key = matchKey(m);
    const perSource = {};
    let missingSource = null;

    for (const name of activeNames) {
      const entry = sources[name].data.get(key);
      perSource[name] = entry || null;
      if (!entry) { missingSource = name; break; }
    }

    if (missingSource) {
      divergences.push({
        match: `${m.home} x ${m.away}`,
        reason: `não encontrado em source "${missingSource}"`,
      });
      continue;
    }

    const tsList = activeNames.map((n) => perSource[n].timestamp);
    const spread = Math.max(...tsList) - Math.min(...tsList);
    if (spread > TS_TOLERANCE_MS) {
      divergences.push({
        match: `${m.home} x ${m.away}`,
        reason: `timestamp spread ${(spread/1000).toFixed(1)}s > ${TS_TOLERANCE_MS/1000}s`,
        timestamps: tsList,
      });
      continue;
    }

    confirmed.push({
      ...m,
      consensus: {
        confirmedAt: Date.now(),
        sources: activeNames.slice(),
        timestampSpreadMs: spread,
        oddsEnabled: ODDS_ENABLED,
        perSource: Object.fromEntries(
          activeNames.map((n) => [n, { status: perSource[n].status, timestamp: perSource[n].timestamp }])
        ),
      },
    });
  }

  if (divergences.length) {
    console.warn(`[CONSENSUS DIVERGENCE] ${divergences.length} matches divergiram`);
    for (const d of divergences.slice(0, 5)) {
      console.warn(`  - ${d.match}: ${d.reason}`);
    }
  }

  console.log(`[CONSENSUS] ${confirmed.length}/${matches.length} matches confirmados pelas ${activeNames.length} fontes (${activeNames.join('+')})`);
  return { confirmed, divergences, failedSources: [] };
}

module.exports = {
  confirmMatches,
  fetchAllSources,
  matchKey,
  normalize,
  withRetry,
  STRICT_REAL_ONLY,
  TS_TOLERANCE_MS,
  RETRIES,
  SOURCE_NAMES,
  ODDS_ENABLED,
  ODDS_OPTIONAL,
};
