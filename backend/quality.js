/**
 * Robotrend IA — Signal Quality Tracker
 *
 *   Mede e expõe a assertividade dos sinais por:
 *     - liga
 *     - mercado (Escanteios, BTTS, Over 2.5)
 *     - faixa de horário (0-5h, 6-11h, 12-17h, 18-23h)
 *     - bucket de confiança (50-69 / 70-84 / 85-100)
 *
 *   Também produz um ranking dos top performers + dynamic weights
 *   que podem ser aplicados pelo ml.reinforce na próxima geração.
 */

'use strict';

function timeBucket(date) {
  const h = new Date(date || Date.now()).getHours();
  if (h < 6)  return '00-05';
  if (h < 12) return '06-11';
  if (h < 18) return '12-17';
  return '18-23';
}

function confBucket(c) {
  if (c >= 85) return '85-100';
  if (c >= 70) return '70-84';
  return '50-69';
}

function bucketize(signals) {
  const buckets = {
    byLeague: {}, byMarket: {}, byHour: {}, byConfidence: {},
  };
  for (const s of signals) {
    if (!s.result || !['win','loss'].includes(s.result)) continue; // só conta sinais resolvidos
    const lg = s.league || 'Desconhecida';
    const mk = s.market || 'Desconhecido';
    const tb = timeBucket(s.created_at || s.createdAt);
    const cb = confBucket(s.confidence || 0);

    add(buckets.byLeague, lg, s);
    add(buckets.byMarket, mk, s);
    add(buckets.byHour, tb, s);
    add(buckets.byConfidence, cb, s);
  }
  return Object.fromEntries(
    Object.entries(buckets).map(([k, v]) => [k, summarize(v)])
  );
}

function add(map, key, s) {
  if (!map[key]) map[key] = { wins: 0, losses: 0, total: 0 };
  map[key].total++;
  if (s.result === 'win') map[key].wins++;
  else map[key].losses++;
}

function summarize(map) {
  return Object.fromEntries(
    Object.entries(map).map(([k, v]) => {
      const winrate = v.total ? Math.round((v.wins / v.total) * 100) : 0;
      const roi = v.total ? Math.round(((v.wins * 0.85 - v.losses) / v.total) * 100) : 0;
      return [k, { ...v, winrate, roi }];
    })
  );
}

/**
 * Top N performers por categoria.
 */
function topPerformers(buckets, n = 5) {
  return {
    leagues: top(buckets.byLeague, n),
    markets: top(buckets.byMarket, n),
    hours:   top(buckets.byHour, n),
    confidence: top(buckets.byConfidence, n),
  };
}

function top(map, n) {
  return Object.entries(map || {})
    .filter(([, v]) => v.total >= 3) // mínimo 3 sinais para entrar no ranking
    .sort((a, b) => b[1].winrate - a[1].winrate || b[1].total - a[1].total)
    .slice(0, n)
    .map(([k, v]) => ({ key: k, ...v }));
}

/**
 * Gera weights dinâmicos baseados no histórico real.
 * Pode ser carregado no startup e injetado no ml.js.
 *
 *   wr 75%+  → weight 1.10
 *   wr 60-74 → weight 1.00
 *   wr <60   → weight 0.92
 */
function dynamicWeights(buckets) {
  const out = { leagues: {}, hours: {} };
  for (const [k, v] of Object.entries(buckets.byLeague || {})) {
    if (v.total < 5) continue;
    out.leagues[k] = v.winrate >= 75 ? 1.10 : v.winrate >= 60 ? 1.0 : 0.92;
  }
  for (const [k, v] of Object.entries(buckets.byHour || {})) {
    if (v.total < 5) continue;
    out.hours[k] = v.winrate >= 75 ? 1.05 : v.winrate >= 60 ? 1.0 : 0.95;
  }
  return out;
}

/**
 * Min-score adaptativo por mercado, a partir da winrate global do mercado.
 *   <50% → +5 (mais exigente)
 *   50-65 → manter
 *   >65 → -3 (mais permissivo)
 */
function adaptiveMarketMinScore(buckets, baseline = 80) {
  const out = {};
  for (const [k, v] of Object.entries(buckets.byMarket || {})) {
    if (v.total < 5) continue;
    if (v.winrate < 50)      out[k] = baseline + 5;
    else if (v.winrate > 65) out[k] = Math.max(70, baseline - 3);
    else                     out[k] = baseline;
  }
  return out;
}

async function buildReport(db) {
  const signals = await db.listSignals(1000);
  const buckets = bucketize(signals);
  const ranking = topPerformers(buckets);
  const weights = dynamicWeights(buckets);
  const marketMinScore = adaptiveMarketMinScore(buckets);
  const resolved = signals.filter((s) => ['win','loss'].includes(s.result));
  const wins = resolved.filter((s) => s.result === 'win').length;
  const losses = resolved.length - wins;
  return {
    summary: {
      total: signals.length,
      resolved: resolved.length,
      pending: signals.length - resolved.length,
      wins, losses,
      winrate: resolved.length ? Math.round((wins / resolved.length) * 100) : 0,
      roi: resolved.length ? Math.round(((wins * 0.85 - losses) / resolved.length) * 100) : 0,
    },
    buckets,
    ranking,
    weights,
    marketMinScore,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { buildReport, bucketize, topPerformers, dynamicWeights, adaptiveMarketMinScore, timeBucket, confBucket };
