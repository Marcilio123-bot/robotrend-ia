/**
 * Robotrend IA — Football Provider (híbrido com failover)
 *
 * Encadeia múltiplos providers gratuitos. Em chamadas live (`getLiveFixtures`)
 * tenta o primário; se receber 403 / breaker OPEN / lista vazia, faz fallback
 * automático para o próximo. Mantém estado "atual" para os snapshots/logs.
 *
 * Ordem default (FOOTBALL_PROVIDER_PRIORITY):
 *   thesportsdb → sofascore → apisports
 *
 * Cada provider mantém SUA própria instância (imports lazy) e expõe a
 * mesma interface (apiFootball.js).
 */

'use strict';

const REGISTRY = {
  thesportsdb: () => require('./thesportsdbProvider'),
  sofascore:   () => require('./sofascoreProvider'),
  apisports:   () => require('./apiFootball'),
};

function parsePriority() {
  // Compat: FOOTBALL_PROVIDER (singular) seleciona um único; PRIORITY define a lista.
  const single = String(process.env.FOOTBALL_PROVIDER || '').toLowerCase().trim();
  const list   = String(process.env.FOOTBALL_PROVIDER_PRIORITY || 'thesportsdb,sofascore,apisports')
    .toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);

  if (single && REGISTRY[single]) {
    // Coloca o singular no topo e mantém os demais como fallback
    return [single, ...list.filter((n) => n !== single)];
  }
  return list.filter((n) => REGISTRY[n]);
}

const PRIORITY = parsePriority();
console.log(`[LIVE PROVIDER] priority: ${PRIORITY.join(' → ')}`);

const providers = {};
for (const name of PRIORITY) {
  try { providers[name] = REGISTRY[name](); }
  catch (e) { console.warn(`[LIVE PROVIDER] falha ao carregar ${name}: ${e.message}`); }
}

let activeName = PRIORITY.find((n) => providers[n]) || 'thesportsdb';
console.log(`[LIVE PROVIDER] ativo: ${activeName}`);

function activeProvider() { return providers[activeName] || providers[PRIORITY[0]]; }

/** True se o erro indica bloqueio explícito do provider (403/429/CIRCUIT_OPEN). */
function shouldSwitchOn(err, result) {
  if (err) {
    const s = err.status;
    if (s === 403 || s === 401 || s === 429) return true;
    if (err.code === 'CIRCUIT_OPEN') return true;
  }
  if (Array.isArray(result) && result.__stale) return true;
  return false;
}

function rotateProvider(reason) {
  const idx = PRIORITY.indexOf(activeName);
  for (let i = 1; i <= PRIORITY.length; i++) {
    const next = PRIORITY[(idx + i) % PRIORITY.length];
    if (!providers[next]) continue;
    if (next === activeName) break;
    console.warn(`[PROVIDER SWITCH] ${activeName} → ${next} (${reason})`);
    activeName = next;
    return;
  }
}

/**
 * getLiveFixtures com failover automático. Tenta cada provider na ordem
 * de prioridade; aceita a primeira resposta NÃO-stale e NÃO-vazia.
 */
async function getLiveFixtures(opts) {
  const startIdx = PRIORITY.indexOf(activeName);
  let lastResult = [];
  for (let i = 0; i < PRIORITY.length; i++) {
    const name = PRIORITY[(startIdx + i) % PRIORITY.length];
    const p = providers[name];
    if (!p) continue;
    try {
      const result = await p.getLiveFixtures(opts);
      // Aceita resposta fresca com ao menos 1 jogo
      if (Array.isArray(result) && !result.__stale && result.length > 0) {
        if (name !== activeName) {
          console.log(`[PROVIDER SWITCH] ${activeName} → ${name} (resposta válida)`);
          activeName = name;
        }
        return result;
      }
      // Resposta vazia mas válida (sem stale) — guarda como melhor candidato
      if (Array.isArray(result) && !result.__stale) {
        lastResult = result;
        continue;
      }
      lastResult = result || [];
    } catch (err) {
      console.warn(`[FETCH ERROR] ${name} getLiveFixtures: ${err.message} (${err.status || err.code || ''})`);
      if (shouldSwitchOn(err, null)) {
        rotateProvider(`erro ${err.status || err.code || 'desconhecido'}`);
        continue;
      }
      lastResult = [];
    }
  }
  return lastResult;
}

/* ============================================================
   Demais métodos — apenas delegam ao provider ATIVO atual.
   ============================================================ */
function makeDelegate(method, defaultValue) {
  return async function (...args) {
    const p = activeProvider();
    if (typeof p?.[method] !== 'function') return defaultValue;
    try { return await p[method](...args); }
    catch (e) {
      console.warn(`[FETCH ERROR] ${activeName}.${method}: ${e.message}`);
      return defaultValue;
    }
  };
}

module.exports = {
  // estado
  get providerName() { return activeName; },
  get providers() { return Object.keys(providers); },
  priority: PRIORITY,

  // gates
  isConfigured: () => !!activeProvider(),
  isSafeMode:    () => activeProvider()?.isSafeMode?.()    ?? false,
  safeMode:      () => activeProvider()?.safeMode?.()      ?? { active: false },
  remainingRatio:() => activeProvider()?.remainingRatio?.()?? 1,
  get breaker()  { return activeProvider()?.breaker || null; },
  quota:         () => activeProvider()?.quota?.()         ?? { provider: activeName },
  status() {
    const a = activeProvider();
    return {
      ...(a?.status?.() || {}),
      activeProvider: activeName,
      priority: PRIORITY,
      available: Object.keys(providers),
    };
  },
  cacheClear: makeDelegate('cacheClear', 0),

  // live
  getLiveFixtures,
  // delegados para o provider ativo
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
