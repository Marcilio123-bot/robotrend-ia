/**
 * Robotrend IA — Demo Provider (sintético)
 *
 * Fallback FINAL quando todos os providers reais falham. Gera matches
 * sintéticos plausíveis (ligas reais, times reais, placares evoluindo
 * conforme tempo real) para que o painel NUNCA fique vazio em dev/test.
 *
 * NUNCA é primário. Só entra na rotação se `FOOTBALL_PROVIDER_PRIORITY`
 * incluir "demo" (default: incluído como último recurso).
 *
 * Caracteristicas:
 *   - Sempre `dataQuality = 'partial'` (placar/minuto/status only)
 *   - Sempre marca `flags.source = 'demo'` e `match.provider = 'demo'`
 *   - Tempo avança em tempo real (1 min real = 1 min de jogo)
 *   - Gols são "rolados" estatisticamente a cada chamada
 *   - 6 partidas fictícias mas com ligas/times reais
 */

'use strict';

const ENABLED = String(process.env.DEMO_PROVIDER_ENABLED || 'true').toLowerCase() !== 'false';

// Pool de partidas sintéticas. Carregadas uma vez ao boot, evoluem no tempo.
const POOL_SEEDS = [
  { id: 'demo-1', home: 'Flamengo',    away: 'Palmeiras',   league: 'Brasileirão Série A',  country: 'Brazil',     startOffsetMin: 18 },
  { id: 'demo-2', home: 'Real Madrid', away: 'Barcelona',   league: 'La Liga',              country: 'Spain',      startOffsetMin: 35 },
  { id: 'demo-3', home: 'Man City',    away: 'Liverpool',   league: 'Premier League',       country: 'England',    startOffsetMin: 52 },
  { id: 'demo-4', home: 'Inter',       away: 'Milan',       league: 'Serie A',              country: 'Italy',      startOffsetMin: 68 },
  { id: 'demo-5', home: 'PSG',         away: 'Marseille',   league: 'Ligue 1',              country: 'France',     startOffsetMin: 8  },
  { id: 'demo-6', home: 'Bayern',      away: 'Dortmund',    league: 'Bundesliga',           country: 'Germany',    startOffsetMin: 76 },
];

// Estado vivo
const matches = new Map();
const bootAt = Date.now();

function seedToMatch(seed) {
  const elapsedMin = Math.min(95, Math.max(1, seed.startOffsetMin + Math.floor((Date.now() - bootAt) / 60_000)));
  return {
    _seed: seed,
    _lastRolledAt: 0,
    _scoreHome: 0,
    _scoreAway: 0,
    elapsedMin,
  };
}

function ensurePool() {
  if (matches.size > 0) return;
  for (const seed of POOL_SEEDS) matches.set(seed.id, seedToMatch(seed));
}

function tickPool() {
  ensurePool();
  const now = Date.now();
  for (const [id, m] of matches) {
    const seed = m._seed;
    const newMin = Math.min(95, seed.startOffsetMin + Math.floor((now - bootAt) / 60_000));
    // Gol aleatório a cada minuto novo (5% chance)
    if (newMin > m.elapsedMin) {
      const diff = newMin - m.elapsedMin;
      for (let i = 0; i < diff; i++) {
        if (Math.random() < 0.05) {
          if (Math.random() < 0.55) m._scoreHome++;
          else m._scoreAway++;
        }
      }
      m.elapsedMin = newMin;
    }
    // Reset jogos "encerrados" (>= 95') para novo ciclo
    if (m.elapsedMin >= 95) {
      m._scoreHome = 0;
      m._scoreAway = 0;
      m._seed = { ...seed, startOffsetMin: Math.floor(Math.random() * 30) };
      m.elapsedMin = m._seed.startOffsetMin;
    }
  }
}

function buildLiveMatch(m) {
  const seed = m._seed;
  const minute = m.elapsedMin;
  const status = minute >= 45 && minute < 46 ? 'HT' : 'LIVE';
  const sh = m._scoreHome;
  const sa = m._scoreAway;
  const id = seed.id;
  return {
    id,
    fixtureId: id,
    league: { id: null, name: seed.league, country: seed.country, logo: null, flag: null, season: 2026, round: 'Demo' },
    teams: {
      home: { id: null, name: seed.home, logo: null },
      away: { id: null, name: seed.away, logo: null },
    },
    home: seed.home,
    away: seed.away,
    minute,
    status,
    statusLong: status === 'HT' ? 'Intervalo' : 'Ao vivo',
    venue: 'Estádio Demo',
    kickoffAt: new Date(bootAt - seed.startOffsetMin * 60_000).toISOString(),
    date: new Date(bootAt - seed.startOffsetMin * 60_000).toISOString(),
    score: {
      home: sh, away: sa,
      ht: { home: null, away: null }, ft: null,
      halftime: { home: null, away: null }, fulltime: null,
    },
    stats: null, perMinute: null, events: [],
    enriched: false, enrichedAt: null,
    flags: { isLive: true, isFinished: false, isFromLiveAPI: false, source: 'demo' },
    lastApiUpdate: Date.now(),
    provider: 'demo',
    dataQuality: 'partial',
    fixture: { id, date: null, status: { short: status, long: status, elapsed: minute }, venue: { name: 'Estádio Demo', city: null }, referee: null },
    goals: { home: sh, away: sa },
  };
}

/* ============================================================
   PUBLIC API
   ============================================================ */
function isConfigured() { return ENABLED; }

async function getLiveFixtures() {
  if (!ENABLED) {
    const empty = [];
    Object.defineProperty(empty, '__stale', { value: true, enumerable: false });
    Object.defineProperty(empty, '__fallbackReason', { value: 'demo_disabled', enumerable: false });
    return empty;
  }
  tickPool();
  console.log('[FETCH OK] demo provider — gerando', matches.size, 'matches sintéticos');
  return Array.from(matches.values()).map(buildLiveMatch);
}

async function getFixtureById()       { return []; }
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

function isSafeMode() { return false; }
function safeMode() { return { active: false }; }
function remainingRatio() { return 1; }
function quota() { return { provider: 'demo', dailyLimit: null, dailyRemaining: null, minuteLimit: null, minuteRemaining: null }; }
function status() {
  return {
    provider: 'demo',
    configured: ENABLED,
    keyValid: true,
    hasKey: false,
    host: 'localhost',
    baseURL: 'memory://demo',
    legacyRapidApi: false,
    httpClientReady: ENABLED,
    timeoutMs: 0,
    retryMax: 0,
    rateLimit: { perMin: null, perDay: null, windowUsed: 0, dayUsed: 0 },
    quota: quota(),
    cacheStore: { backend: 'memory', size: matches.size },
    inflight: 0,
    breaker: { name: 'demo', state: 'CLOSED', failures: 0, totals: { exec: 0, fail: 0, shortCircuit: 0 } },
    safeMode: safeMode(),
  };
}
async function cacheClear() { return 0; }

module.exports = {
  isConfigured,
  status,
  cacheClear,
  quota,
  breaker: { snapshot: () => ({ name: 'demo', state: 'CLOSED', failures: 0, totals: { exec: 0, fail: 0, shortCircuit: 0 } }) },
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
};
