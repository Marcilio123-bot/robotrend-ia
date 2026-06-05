/**
 * Robotrend IA — API-Football Usage Tracker
 *
 * Registra TODA chamada REAL à API-Sports (1 crédito = 1 chamada de rede),
 * no exato ponto em que o crédito é gasto (apiFootball.rawGet). Cache hits e
 * dedup de in-flight NÃO contam — só sai daqui o que realmente bateu na rede.
 *
 * Mantém:
 *   - total acumulado + por endpoint
 *   - buckets horários (48h) e diários (60d) → gráficos
 *   - janela rolante da última hora (precisa)
 *   - atribuição por fonte: poller | enricher | route | other
 *
 * Persistência best-effort em data/api-usage.json (sobrevive a restart para
 * manter a projeção mensal). Nunca lança — telemetria não pode quebrar a API.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { logger } = require('../logger');

const log = logger.child({ module: 'api-usage' });

const HOUR_MS = 3_600_000;
const DAY_MS  = 86_400_000;
const KEEP_HOURS = 48;
const KEEP_DAYS  = 60;
const LASTHOUR_CAP = 8000;
const PERSIST_PATH = path.join(process.cwd(), 'data', 'api-usage.json');
const PERSIST_INTERVAL_MS = Number(process.env.API_USAGE_PERSIST_MS || 60_000);
const LOG_INTERVAL_MS = Number(process.env.API_USAGE_LOG_MS || 5 * 60_000);

function hourKey(ts) { return new Date(ts).toISOString().slice(0, 13); } // YYYY-MM-DDTHH
function dayKey(ts)  { return new Date(ts).toISOString().slice(0, 10); } // YYYY-MM-DD

/**
 * Atribui a chamada a uma fonte lógica a partir do endpoint+params.
 *   - fixtures?live=all                         → poller (único caller)
 *   - fixtures/statistics | fixtures/events     → enricher (caller dominante)
 *   - demais fixtures/odds/predictions/leagues  → route (sob demanda)
 */
function classifySource(endpoint, params) {
  if (endpoint === 'fixtures' && params && String(params.live) === 'all') return 'poller';
  if (endpoint === 'fixtures/statistics' || endpoint === 'fixtures/events') return 'enricher';
  if (
    endpoint === 'fixtures' || endpoint.startsWith('fixtures/') ||
    endpoint === 'teams/statistics' || endpoint === 'odds' || endpoint === 'odds/live' ||
    endpoint === 'predictions' || endpoint === 'leagues'
  ) return 'route';
  return 'other';
}

const state = {
  startedAt: Date.now(),
  totalCalls: 0,
  byEndpoint: {},        // endpoint -> count acumulado
  hourly: {},            // hourKey -> { total, byEndpoint:{}, bySource:{} }
  daily: {},             // dayKey  -> { total, byEndpoint:{}, bySource:{} }
  lastHourEvents: [],    // [{ ts, source }]
};

let _lastLogAt = 0;
let _lastPersistAt = 0;
let _loaded = false;

function _bump(container, key, n = 1) { container[key] = (container[key] || 0) + n; }

/** Registra UMA chamada real à API. Chamado de apiFootball.rawGet. */
function record(endpoint, params) {
  try {
    if (!_loaded) load();
    const ts = Date.now();
    const source = classifySource(endpoint, params);

    state.totalCalls++;
    _bump(state.byEndpoint, endpoint);

    const hk = hourKey(ts);
    const hb = state.hourly[hk] || (state.hourly[hk] = { total: 0, byEndpoint: {}, bySource: {} });
    hb.total++; _bump(hb.byEndpoint, endpoint); _bump(hb.bySource, source);

    const dk = dayKey(ts);
    const dbk = state.daily[dk] || (state.daily[dk] = { total: 0, byEndpoint: {}, bySource: {} });
    dbk.total++; _bump(dbk.byEndpoint, endpoint); _bump(dbk.bySource, source);

    state.lastHourEvents.push({ ts, source });
    if (state.lastHourEvents.length > LASTHOUR_CAP) {
      state.lastHourEvents.splice(0, state.lastHourEvents.length - LASTHOUR_CAP);
    }

    _prune(ts);
    _maybeLog(ts);
    _maybePersist(ts);
  } catch (_) { /* telemetria nunca quebra a API */ }
}

function _prune(now) {
  const hCut = now - KEEP_HOURS * HOUR_MS;
  for (const k of Object.keys(state.hourly)) {
    if (Date.parse(k + ':00:00Z') < hCut) delete state.hourly[k];
  }
  const dCut = now - KEEP_DAYS * DAY_MS;
  for (const k of Object.keys(state.daily)) {
    if (Date.parse(k + 'T00:00:00Z') < dCut) delete state.daily[k];
  }
  const eCut = now - HOUR_MS;
  let i = 0;
  while (i < state.lastHourEvents.length && state.lastHourEvents[i].ts < eCut) i++;
  if (i > 0) state.lastHourEvents.splice(0, i);
}

function _maybeLog(now) {
  if (now - _lastLogAt < LOG_INTERVAL_MS) return;
  _lastLogAt = now;
  const today = state.daily[dayKey(now)] || { total: 0, bySource: {} };
  const lastHour = state.lastHourEvents.length;
  const s = today.bySource || {};
  console.log(
    `[API USAGE] today=${today.total} lastHour=${lastHour} ` +
    `poller=${s.poller || 0} enricher=${s.enricher || 0} route=${s.route || 0} other=${s.other || 0} ` +
    `totalSinceBoot=${state.totalCalls}`
  );
}

function _maybePersist(now) {
  if (now - _lastPersistAt < PERSIST_INTERVAL_MS) return;
  _lastPersistAt = now;
  persist();
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(PERSIST_PATH), { recursive: true });
    const payload = JSON.stringify({ daily: state.daily, byEndpoint: state.byEndpoint, savedAt: Date.now() });
    fs.writeFileSync(PERSIST_PATH, payload);
  } catch (e) {
    log.debug?.('persist falhou', { err: e.message });
  }
}

function load() {
  _loaded = true;
  try {
    if (!fs.existsSync(PERSIST_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(PERSIST_PATH, 'utf8'));
    if (raw && typeof raw === 'object') {
      if (raw.daily && typeof raw.daily === 'object') {
        for (const [k, v] of Object.entries(raw.daily)) {
          if (!state.daily[k]) state.daily[k] = v;
        }
      }
      if (raw.byEndpoint && typeof raw.byEndpoint === 'object') {
        for (const [k, v] of Object.entries(raw.byEndpoint)) {
          state.byEndpoint[k] = (state.byEndpoint[k] || 0) + Number(v || 0);
        }
      }
    }
    _prune(Date.now());
  } catch (e) {
    log.debug?.('load falhou', { err: e.message });
  }
}

/**
 * Snapshot completo para o endpoint admin. Inclui séries para gráfico
 * (24h e 30d), totais por endpoint, e atribuição por fonte do dia.
 */
function snapshot() {
  const now = Date.now();
  if (!_loaded) load();
  _prune(now);

  const todayKey = dayKey(now);
  const today = state.daily[todayKey] || { total: 0, byEndpoint: {}, bySource: {} };

  // Série horária (últimas 24h)
  const hourly = [];
  for (let i = 23; i >= 0; i--) {
    const t = now - i * HOUR_MS;
    const k = hourKey(t);
    hourly.push({ hour: k, label: k.slice(11) + 'h', total: state.hourly[k]?.total || 0 });
  }

  // Série diária (últimos 30 dias)
  const daily = [];
  for (let i = 29; i >= 0; i--) {
    const t = now - i * DAY_MS;
    const k = dayKey(t);
    daily.push({ day: k, label: k.slice(5), total: state.daily[k]?.total || 0 });
  }

  // Top endpoints (acumulado)
  const byEndpoint = Object.entries(state.byEndpoint)
    .map(([endpoint, count]) => ({ endpoint, count }))
    .sort((a, b) => b.count - a.count);

  // Média diária: dias COMPLETOS (exclui hoje, parcial) com tráfego.
  const completeDays = daily.slice(0, -1).filter((d) => d.total > 0);
  const avgDaily = completeDays.length
    ? Math.round(completeDays.reduce((s, d) => s + d.total, 0) / completeDays.length)
    : today.total;

  // Run-rate de hoje extrapolado para 24h (fração do dia decorrida em UTC).
  const dayStart = Date.parse(todayKey + 'T00:00:00Z');
  const elapsedFrac = Math.max(0.01, Math.min(1, (now - dayStart) / DAY_MS));
  const todayProjected = Math.round(today.total / elapsedFrac);

  return {
    startedAt: state.startedAt,
    callsToday: today.total,
    callsLastHour: state.lastHourEvents.length,
    todayBySource: today.bySource || {},
    pollerToday: today.bySource?.poller || 0,
    enricherToday: today.bySource?.enricher || 0,
    routeToday: today.bySource?.route || 0,
    otherToday: today.bySource?.other || 0,
    byEndpoint,
    totalSinceBoot: state.totalCalls,
    charts: { hourly, daily },
    avgDaily,
    todayProjected,
    completeDaysSampled: completeDays.length,
    generatedAt: new Date(now).toISOString(),
  };
}

module.exports = { record, snapshot, persist, load, classifySource };
