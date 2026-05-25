/**
 * Robotrend IA — Football Provider (híbrido com failover + agregação)
 *
 * Encadeia múltiplos providers para cobertura máxima de jogos live.
 *
 * Dois modos de operação para `getLiveFixtures`:
 *
 *   1. FAILOVER (default): tenta cada provider na ordem da PRIORITY até
 *      um devolver lista não-stale e não-vazia. Garante baixa pressão
 *      sobre as APIs e quota preservada.
 *
 *   2. AGGREGATED (SCANNER_AGGREGATE_PROVIDERS=true): chama TODOS os
 *      providers configurados em paralelo, normaliza e DEDUPA por
 *      `home|away`. Maximiza cobertura — útil para o Scanner Mode.
 *      Cada match recebe `match._aggregatedSources: ['sofascore','thesportsdb']`
 *      para o frontend mostrar de quantas fontes veio.
 *
 * Ordem default (FOOTBALL_PROVIDER_PRIORITY):
 *   bet365data → thesportsdb → football-data → apisports → demo
 *
 *   - Bet365Data (RapidAPI) é PRIMARY: live + odds + stats com contrato comercial
 *   - TheSportsDB e football-data como fallback gratuito
 *   - API-Sports só se houver chave paga
 *   - demo só como último recurso (mantém painel vivo)
 *   - SofaScore REMOVIDO do default (Cloudflare bloqueia com HTTP 403)
 *     Para reabilitar manualmente: FOOTBALL_PROVIDER_PRIORITY=bet365data,sofascore,…
 *
 * Cada provider mantém SUA própria instância (imports lazy) e expõe a
 * mesma interface (apiFootball.js).
 */

'use strict';

const REGISTRY = {
  'bet365data':    () => require('./bet365dataProvider'),
  bet365:          () => require('./bet365dataProvider'),
  'football-data': () => require('./footballDataProvider'),
  footballdata:    () => require('./footballDataProvider'),
  thesportsdb:     () => require('./thesportsdbProvider'),
  sofascore:       () => require('./sofascoreProvider'),
  apisports:       () => require('./apiFootball'),
  demo:            () => require('./demoProvider'),
};

function parsePriority() {
  // Compat: FOOTBALL_PROVIDER (singular) seleciona um único; PRIORITY define a lista.
  const single = String(process.env.FOOTBALL_PROVIDER || '').toLowerCase().trim();
  // Nova ordem default: Bet365Data primário (RapidAPI, odds + live + stats).
  // SofaScore foi REMOVIDO do default — Cloudflare bloqueia com HTTP 403 em produção.
  // Para reabilitar, defina FOOTBALL_PROVIDER_PRIORITY manualmente.
  const list   = String(process.env.FOOTBALL_PROVIDER_PRIORITY || 'bet365data,thesportsdb,football-data,apisports,demo')
    .toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);

  if (single && REGISTRY[single]) {
    // Coloca o singular no topo e mantém os demais como fallback
    return [single, ...list.filter((n) => n !== single)];
  }
  return list.filter((n) => REGISTRY[n]);
}

const PRIORITY = parsePriority();
const AGGREGATE_PROVIDERS = String(process.env.SCANNER_AGGREGATE_PROVIDERS || 'false').toLowerCase() === 'true';
console.log(`[LIVE PROVIDER] priority: ${PRIORITY.join(' → ')}  ${AGGREGATE_PROVIDERS ? '· AGGREGATED' : '· failover'}`);

const providers = {};
for (const name of PRIORITY) {
  try { providers[name] = REGISTRY[name](); }
  catch (e) { console.warn(`[LIVE PROVIDER] falha ao carregar ${name}: ${e.message}`); }
}

/** True se pelo menos um provider da chain está configurado (ex.: sofascore sem chave). */
function hasAnyConfiguredProvider() {
  return PRIORITY.some((name) => {
    const p = providers[name];
    return p && (typeof p.isConfigured !== 'function' || p.isConfigured());
  });
}

// Provider ativo começa no topo da prioridade (sofascore por default)
let activeName = PRIORITY.find((n) => providers[n] && (providers[n].isConfigured?.() !== false)) || PRIORITY[0];
const configuredList = PRIORITY.filter((n) => {
  const p = providers[n];
  return p && (typeof p.isConfigured !== 'function' || p.isConfigured());
});
console.log(`[LIVE PROVIDER] ativo: ${activeName || '(nenhum)'}  configurados: [${configuredList.join(', ') || 'nenhum'}]`);

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
 * Chave de dedup para um fixture cru (qualquer provider). Usa nomes dos times
 * normalizados — IDs são incomparáveis entre providers.
 */
function dedupKey(fx) {
  const home = String(
    fx?.teams?.home?.name || fx?.homeTeam?.name || fx?.home || fx?.event_home_team || ''
  ).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '');
  const away = String(
    fx?.teams?.away?.name || fx?.awayTeam?.name || fx?.away || fx?.event_away_team || ''
  ).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '');
  return `${home}__vs__${away}`;
}

/**
 * Modo AGREGADO: chama todos providers configurados em paralelo e dedupa.
 * Match wins go to o primeiro provider da PRIORITY (mais confiável).
 * Anota `_aggregatedSources` (array de provider names) e `_primarySource`.
 */
async function getLiveFixturesAggregated(opts) {
  const candidates = PRIORITY.filter((name) => {
    const p = providers[name];
    return p && (typeof p.isConfigured !== 'function' || p.isConfigured());
  });

  console.log(`[SCANNER PROVIDER] aggregated: tentando ${candidates.length} providers em paralelo (${candidates.join(', ')})`);

  const settled = await Promise.allSettled(
    candidates.map(async (name) => {
      try {
        const t0 = Date.now();
        const result = await providers[name].getLiveFixtures(opts);
        const arr = Array.isArray(result) ? result : [];
        console.log(`[SCANNER PROVIDER]   • ${name}: ${arr.length} matches em ${Date.now() - t0}ms ${arr.__stale ? '(STALE)' : ''}`);
        return { name, result: arr, stale: !!arr.__stale };
      } catch (err) {
        console.warn(`[SCANNER PROVIDER]   ✗ ${name}: ${err.message} (${err.status || err.code || ''})`);
        return { name, result: [], stale: true, error: err.message };
      }
    })
  );

  // Dedup priorizando a ordem da PRIORITY (primeiro = mais confiável)
  const byKey = new Map(); // key → { fx, sources: [providerName, ...] }
  for (const s of settled) {
    if (s.status !== 'fulfilled') continue;
    const { name, result, stale } = s.value;
    if (stale || !result.length) continue;
    for (const fx of result) {
      const k = dedupKey(fx);
      if (!k || k === '__vs__') continue;
      const existing = byKey.get(k);
      if (existing) {
        if (!existing.sources.includes(name)) existing.sources.push(name);
      } else {
        // Anota a fonte primária no objeto (não-enumerable para não poluir o JSON)
        Object.defineProperty(fx, '_aggregatedSources', { value: [name], enumerable: false, writable: true });
        Object.defineProperty(fx, '_primarySource', { value: name, enumerable: false });
        byKey.set(k, { fx, sources: [name] });
      }
    }
  }

  // Reconcilia _aggregatedSources final
  for (const entry of byKey.values()) {
    entry.fx._aggregatedSources = entry.sources.slice();
  }

  const aggregated = Array.from(byKey.values()).map((e) => e.fx);
  const summary = settled
    .map((s) => s.status === 'fulfilled' ? `${s.value.name}=${s.value.result.length}` : 'failed')
    .join(' · ');
  console.log(`[SCANNER PROVIDER] aggregated DONE: ${aggregated.length} matches únicos · ${summary}`);

  if (aggregated.length === 0) {
    // Marca stale para o caller fazer fallback (clock simulado, etc.)
    Object.defineProperty(aggregated, '__stale', { value: true, enumerable: false });
    Object.defineProperty(aggregated, '__fallbackReason', { value: 'all_providers_empty', enumerable: false });
  }
  return aggregated;
}

/**
 * getLiveFixtures com failover automático OU agregação multi-provider.
 *
 * - SCANNER_AGGREGATE_PROVIDERS=true → roda em paralelo, dedupa, retorna união
 * - default → failover sequencial; aceita a primeira resposta NÃO-stale e NÃO-vazia
 */
async function getLiveFixtures(opts = {}) {
  // opts.aggregate sobrescreve a env (útil pra rota scanner forçar)
  const useAggregate = opts.aggregate === true || (opts.aggregate !== false && AGGREGATE_PROVIDERS);
  if (useAggregate) {
    return getLiveFixturesAggregated(opts);
  }

  const startIdx = PRIORITY.indexOf(activeName);
  let lastResult = [];
  for (let i = 0; i < PRIORITY.length; i++) {
    const name = PRIORITY[(startIdx + i) % PRIORITY.length];
    const p = providers[name];
    if (!p) continue;
    // Pula providers não configurados (ex.: football-data sem FOOTBALL_DATA_KEY)
    if (typeof p.isConfigured === 'function' && !p.isConfigured()) {
      continue;
    }
    try {
      const result = await p.getLiveFixtures(opts);
      // Aceita resposta fresca com ao menos 1 jogo
      if (Array.isArray(result) && !result.__stale && result.length > 0) {
        if (name !== activeName) {
          console.log(`[PROVIDER SWITCH] ${activeName} → ${name} (resposta válida, ${result.length} matches)`);
          activeName = name;
        }
        console.log(`[SCANNER PROVIDER] failover OK: ${name} → ${result.length} matches`);
        return result;
      }
      // Resposta vazia mas válida (sem stale) — guarda como melhor candidato
      if (Array.isArray(result) && !result.__stale) {
        console.log(`[SCANNER PROVIDER] ${name}: 0 matches (vazio limpo)`);
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
  hasAnyConfiguredProvider,
  isConfigured: hasAnyConfiguredProvider,
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
  getLiveFixturesAggregated,
  AGGREGATE_PROVIDERS,
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
