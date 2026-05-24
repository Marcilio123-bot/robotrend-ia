/**
 * Robotrend IA — Results aggregator
 *
 *   Lê sinais resolvidos do database (signals com result win/loss/push +
 *   roi numérico já gravado) e produz:
 *     - cumulativeProfit (timeseries)
 *     - daily/weekly/monthly ROI
 *     - currentStreak / bestStreak
 *     - heatmap por hora/dia da semana
 */

'use strict';

const db = require('./database');

const DEFAULT_STAKE = 1;
const DEFAULT_ODD = 1.85;

function pickPnl(signal) {
  // se já tem pnl direto, usa
  if (typeof signal.pnl === 'number') return signal.pnl;
  if (signal.result === 'win')   return DEFAULT_STAKE * (DEFAULT_ODD - 1);
  if (signal.result === 'loss')  return -DEFAULT_STAKE;
  return 0;
}

function dateKey(d, gran = 'day') {
  const dt = new Date(d);
  if (gran === 'day')   return dt.toISOString().slice(0, 10);            // YYYY-MM-DD
  if (gran === 'week')  {                                                // ISO-week-ish
    const onejan = new Date(dt.getFullYear(), 0, 1);
    const week = Math.ceil((((dt - onejan) / 86400000) + onejan.getDay() + 1) / 7);
    return `${dt.getFullYear()}-W${String(week).padStart(2, '0')}`;
  }
  if (gran === 'month') return dt.toISOString().slice(0, 7);             // YYYY-MM
  return dt.toISOString();
}

async function loadResolved(filters = {}) {
  const all = await db.listSignals({ limit: 10_000 });
  return all.filter((s) => s.result === 'win' || s.result === 'loss');
}

async function summary() {
  const list = await loadResolved();
  if (!list.length) {
    return {
      bets: 0, wins: 0, losses: 0, winrate: 0, pnl: 0, roi: 0,
      currentStreak: { type: '-', count: 0 }, bestStreak: { type: '-', count: 0 },
      cumulative: [], daily: {}, weekly: {}, monthly: {},
      heatmap: emptyHeatmap(),
    };
  }
  list.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  let pnl = 0;
  const cumulative = [];
  const daily = {}, weekly = {}, monthly = {};
  const heatmap = emptyHeatmap();
  let cur = { type: list[0].result, count: 0 };
  let best = { type: '-', count: 0 };

  for (const s of list) {
    const v = pickPnl(s);
    pnl += v;
    cumulative.push({ t: s.createdAt, pnl: +pnl.toFixed(2) });

    bumpAgg(daily,   dateKey(s.createdAt, 'day'),   v);
    bumpAgg(weekly,  dateKey(s.createdAt, 'week'),  v);
    bumpAgg(monthly, dateKey(s.createdAt, 'month'), v);

    const dt = new Date(s.createdAt);
    heatmap[dt.getDay()][dt.getHours()] += 1;

    if (s.result === cur.type) cur.count += 1;
    else { cur = { type: s.result, count: 1 }; }
    if (cur.count > best.count) best = { ...cur };
  }

  const wins   = list.filter((s) => s.result === 'win').length;
  const losses = list.filter((s) => s.result === 'loss').length;
  const total = wins + losses;
  const turnover = list.length * DEFAULT_STAKE;
  return {
    bets: list.length,
    wins, losses,
    winrate: total ? Math.round((wins / total) * 100) : 0,
    pnl: +pnl.toFixed(2),
    roi: turnover ? +(pnl / turnover * 100).toFixed(2) : 0,
    currentStreak: cur,
    bestStreak: best,
    cumulative: cumulative.slice(-500),
    daily, weekly, monthly,
    heatmap,
  };
}

function bumpAgg(map, key, v) {
  if (!map[key]) map[key] = { pnl: 0, bets: 0 };
  map[key].pnl = +(map[key].pnl + v).toFixed(2);
  map[key].bets += 1;
  map[key].roi = +(map[key].pnl / (map[key].bets * DEFAULT_STAKE) * 100).toFixed(2);
}

function emptyHeatmap() {
  return Array.from({ length: 7 }, () => Array(24).fill(0));
}

module.exports = { summary };
