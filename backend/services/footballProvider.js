/**
 * Robotrend IA — Football Provider
 *
 * Wrapper fino sobre `apiFootball.js` (API-Football / API-Sports).
 *
 * O sistema opera EXCLUSIVAMENTE com a API-Football. Não há providers
 * secundários, agregação, failover, scraping ou demo. Esta camada existe
 * apenas para manter a interface esperada pelos consumidores (poller,
 * routes, live, consensus, bot, frontend) sem precisar refatorar todos
 * os call sites.
 *
 * Variáveis de ambiente reconhecidas:
 *   API_FOOTBALL_KEY   → chave do dashboard.api-football.com (obrigatória)
 *   API_FOOTBALL_HOST  → default v3.football.api-sports.io
 */

'use strict';

const apiFootball = require('./apiFootball');

const PROVIDER_NAME = 'apisports';
const PRIORITY = [PROVIDER_NAME];

console.log(`[LIVE PROVIDER] API-Football única ativa (${PROVIDER_NAME})`);

function isConfigured() {
  return apiFootball.isConfigured();
}

async function getLiveFixtures(opts = {}) {
  if (!apiFootball.isConfigured()) {
    return apiFootball.emptyFixturesArray('not_configured');
  }
  try {
    return await apiFootball.getLiveFixtures(opts);
  } catch (err) {
    console.warn(`[FETCH ERROR] api-football getLiveFixtures: ${err.message} (${err.status || err.code || ''})`);
    return apiFootball.emptyFixturesArray(err.code || 'fetch_error');
  }
}

function makeDelegate(method, defaultValue) {
  return async function (...args) {
    if (typeof apiFootball[method] !== 'function') return defaultValue;
    try { return await apiFootball[method](...args); }
    catch (e) {
      console.warn(`[FETCH ERROR] api-football.${method}: ${e.message}`);
      return defaultValue;
    }
  };
}

module.exports = {
  // identidade
  get providerName() { return PROVIDER_NAME; },
  get providers()    { return [PROVIDER_NAME]; },
  priority: PRIORITY,
  AGGREGATE_PROVIDERS: false,

  // gates
  hasAnyConfiguredProvider: isConfigured,
  isConfigured,
  isSafeMode:    () => apiFootball.isSafeMode?.()    ?? false,
  safeMode:      () => apiFootball.safeMode?.()      ?? { active: false },
  remainingRatio:() => apiFootball.remainingRatio?.()?? 1,
  get breaker()  { return apiFootball.breaker || null; },
  quota:         () => apiFootball.quota?.()         ?? { provider: PROVIDER_NAME },
  status() {
    return {
      ...(apiFootball.status?.() || {}),
      activeProvider: PROVIDER_NAME,
      priority: PRIORITY,
      available: [PROVIDER_NAME],
    };
  },
  cacheClear: makeDelegate('cacheClear', 0),

  // live
  getLiveFixtures,
  // alias para compat com chamadas legadas — mesmo comportamento.
  getLiveFixturesAggregated: getLiveFixtures,

  // delegados directos para o cliente API-Football
  getFixtureById:       makeDelegate('getFixtureById',       []),
  getFixturesByDate:    makeDelegate('getFixturesByDate',    []),
  getFixturesByTeam:    makeDelegate('getFixturesByTeam',    []),
  getFixtureStatistics: makeDelegate('getFixtureStatistics', []),
  getFixtureEvents:     makeDelegate('getFixtureEvents',     []),
  getFixtureLineups:    makeDelegate('getFixtureLineups',    []),
  getHeadToHead:        makeDelegate('getHeadToHead',        []),
  getPredictions:       makeDelegate('getPredictions',       []),
  getOdds:              makeDelegate('getOdds',              []),
  getOddsLive:          makeDelegate('getOddsLive',          []),
  getTeamStatistics:    makeDelegate('getTeamStatistics',    null),
  getLeagues:           makeDelegate('getLeagues',           []),
};
