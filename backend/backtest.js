/**
 * Robotrend IA — Backtest Engine
 *
 *   Pega um conjunto de partidas históricas com estatísticas e o resultado
 *   final dos mercados (corners totais, BTTS, Over 2.5) e simula como o
 *   robô teria operado, computando winrate + ROI por mercado, por liga, etc.
 *
 *   Formato esperado por partida (snapshot no minuto 75-90):
 *   {
 *     id, home, away, league, date,
 *     minute: 75,
 *     corners: 8, dangerousAttacks: 70, shots: 15, shotsOnTarget: 5, possession: 55,
 *     score: { home: 1, away: 0 },
 *     final: {
 *       cornersTotal: 12,
 *       goalsHome: 2, goalsAway: 1,    // resultado real
 *     },
 *     odds: {                          // opcional para ROI realista
 *       overCorners: 1.85,
 *       underCorners: 1.85,
 *       btts: 1.75, bttsNo: 2.05,
 *       over25: 1.80, under25: 1.95,
 *     }
 *   }
 *
 *   Saída: relatório completo + lista de bets simulados.
 */

'use strict';

const { analyzeLiveMatch, analyzePrelive } = require('./analyzer');
const ml = require('./ml');

const DEFAULT_ODD = 1.85;

function parseSuggestionLine(suggestion) {
  // "Over 10.5 Escanteios" / "Under 8.5 Escanteios" / "BTTS — SIM"
  if (!suggestion) return null;
  const s = suggestion.toUpperCase();
  if (s.includes('BTTS')) return { kind: 'btts', side: s.includes('NÃO') ? 'no' : 'yes' };
  if (s.includes('OVER 2.5')) return { kind: 'over25', side: 'yes' };
  if (s.includes('UNDER 2.5')) return { kind: 'over25', side: 'no' };
  const corner = suggestion.match(/(Over|Under)\s+([\d.]+)\s+Escanteios/i);
  if (corner) {
    return { kind: 'corners', side: corner[1].toLowerCase(), line: Number(corner[2]) };
  }
  return null;
}

function resolveBet(bet, final) {
  if (!bet || !final) return null;
  if (bet.kind === 'corners') {
    const total = Number(final.cornersTotal || 0);
    if (bet.side === 'over')  return total > bet.line ? 'win' : (total < bet.line ? 'loss' : 'push');
    if (bet.side === 'under') return total < bet.line ? 'win' : (total > bet.line ? 'loss' : 'push');
  }
  if (bet.kind === 'btts') {
    const both = Number(final.goalsHome) > 0 && Number(final.goalsAway) > 0;
    return bet.side === 'yes' ? (both ? 'win' : 'loss') : (both ? 'loss' : 'win');
  }
  if (bet.kind === 'over25') {
    const tg = Number(final.goalsHome) + Number(final.goalsAway);
    if (bet.side === 'yes') return tg > 2.5 ? 'win' : 'loss';
    return tg < 2.5 ? 'win' : 'loss';
  }
  return null;
}

function pickOdd(bet, odds) {
  if (!odds || !bet) return DEFAULT_ODD;
  if (bet.kind === 'corners') return Number(bet.side === 'over' ? odds.overCorners : odds.underCorners) || DEFAULT_ODD;
  if (bet.kind === 'btts')    return Number(bet.side === 'yes' ? odds.btts : odds.bttsNo) || DEFAULT_ODD;
  if (bet.kind === 'over25')  return Number(bet.side === 'yes' ? odds.over25 : odds.under25) || DEFAULT_ODD;
  return DEFAULT_ODD;
}

/**
 * Roda o backtest sobre o array fornecido.
 *
 * @param {Array} matches    - histórico (formato acima)
 * @param {object} opts      - { minScore, stake }
 * @returns {object}         - relatório
 */
function runBacktest(matches, opts = {}) {
  const minScore = Number(opts.minScore || 80);
  const stake = Number(opts.stake || 1); // unidades por bet
  const bets = [];
  const byMarket = {};
  const byLeague = {};

  for (const m of matches) {
    if (!m || !m.final) continue;

    // 1) Sinal de escanteios (live) — skipFreshness pois é dado histórico
    const a = analyzeLiveMatch(m, { history: m.history || [], skipFreshness: true });
    const reinforced = ml.reinforce(a, { match: m, history: m.history || [] });
    const parsed = parseSuggestionLine(reinforced.suggestion);
    if (parsed && reinforced.confidence >= minScore && !reinforced.ml.antiFake.fake) {
      const result = resolveBet(parsed, m.final);
      if (result) {
        const odd = pickOdd(parsed, m.odds);
        const pnl = result === 'win' ? stake * (odd - 1) : (result === 'push' ? 0 : -stake);
        bets.push({
          matchId: m.id, league: m.league, market: 'Escanteios',
          suggestion: reinforced.suggestion, confidence: reinforced.confidence,
          result, odd, pnl, date: m.date,
        });
      }
    }

    // 2) BTTS / Over 2.5 (pre-live) — skipFreshness para histórico
    if (m.homeLast6 && m.awayLast6) {
      const pre = analyzePrelive(m, { skipFreshness: true });
      if (pre.shouldSignal) {
        const parsedB = parseSuggestionLine(pre.suggestion);
        if (parsedB) {
          const result = resolveBet(parsedB, m.final);
          if (result) {
            const odd = pickOdd(parsedB, m.odds);
            const pnl = result === 'win' ? stake * (odd - 1) : (result === 'push' ? 0 : -stake);
            bets.push({
              matchId: m.id, league: m.league, market: 'BTTS',
              suggestion: pre.suggestion, confidence: pre.confidence,
              result, odd, pnl, date: m.date,
            });
          }
        }
        if (pre.over25?.suggestion) {
          const parsedO = parseSuggestionLine(pre.over25.suggestion);
          if (parsedO) {
            const result = resolveBet(parsedO, m.final);
            if (result) {
              const odd = pickOdd(parsedO, m.odds);
              const pnl = result === 'win' ? stake * (odd - 1) : (result === 'push' ? 0 : -stake);
              bets.push({
                matchId: m.id, league: m.league, market: 'Over 2.5',
                suggestion: pre.over25.suggestion, confidence: pre.confidence,
                result, odd, pnl, date: m.date,
              });
            }
          }
        }
      }
    }
  }

  // Agregações
  for (const b of bets) {
    addAgg(byMarket, b.market, b);
    addAgg(byLeague, b.league || 'Desconhecida', b);
  }

  return {
    summary: aggregate(bets, stake),
    byMarket: Object.fromEntries(Object.entries(byMarket).map(([k, v]) => [k, aggregate(v, stake)])),
    byLeague: Object.fromEntries(Object.entries(byLeague).map(([k, v]) => [k, aggregate(v, stake)])),
    bets,
    config: { minScore, stake, totalMatches: matches.length },
    generatedAt: new Date().toISOString(),
  };
}

function addAgg(map, key, bet) {
  if (!map[key]) map[key] = [];
  map[key].push(bet);
}

function aggregate(bets, stake) {
  const wins = bets.filter((b) => b.result === 'win').length;
  const losses = bets.filter((b) => b.result === 'loss').length;
  const pushes = bets.filter((b) => b.result === 'push').length;
  const pnl = bets.reduce((s, b) => s + b.pnl, 0);
  const turnover = bets.length * stake;
  const total = wins + losses; // pushes não contam pra winrate
  return {
    bets: bets.length,
    wins, losses, pushes,
    winrate: total ? Math.round((wins / total) * 100) : 0,
    pnl: +pnl.toFixed(2),
    roi: turnover ? +(pnl / turnover * 100).toFixed(2) : 0,
    avgOdd: bets.length ? +(bets.reduce((s, b) => s + b.odd, 0) / bets.length).toFixed(2) : 0,
  };
}

/**
 * Gera dataset sintético para validação rápida sem upload real.
 * Bons para testar o robô em ambiente controlado.
 */
function buildSyntheticDataset(n = 200) {
  const leagues = ['Premier League','La Liga','Brasileirão Série A','Bundesliga','Serie A Italiana'];
  const teams = ['Alpha','Beta','Gamma','Delta','Epsilon','Zeta','Theta','Sigma','Omega','Lambda'];
  const out = [];
  for (let i = 0; i < n; i++) {
    const home = teams[Math.floor(Math.random() * teams.length)];
    let away;
    do { away = teams[Math.floor(Math.random() * teams.length)]; } while (away === home);
    const minute = 75 + Math.floor(Math.random() * 15);
    const dangerous = 30 + Math.floor(Math.random() * 80);
    const shots = 4 + Math.floor(Math.random() * 22);
    const corners = 2 + Math.floor(Math.random() * 12);
    const cornersTotal = corners + Math.floor(Math.random() * 6); // 0..5 a mais
    const goalsHome = Math.floor(Math.random() * 4);
    const goalsAway = Math.floor(Math.random() * 3);

    // homeLast6 / awayLast6 sintéticos
    const last6 = () => Array.from({ length: 6 }, () => ({
      goalsFor: Math.random() < 0.7 ? 1 + Math.floor(Math.random() * 3) : 0,
      goalsAgainst: Math.random() < 0.55 ? 1 + Math.floor(Math.random() * 2) : 0,
      shots: 6 + Math.floor(Math.random() * 14),
    }));

    out.push({
      id: `bt-${i + 1}`,
      home, away,
      league: leagues[Math.floor(Math.random() * leagues.length)],
      date: new Date(Date.now() - i * 3600 * 1000).toISOString(),
      minute,
      corners, dangerousAttacks: dangerous, shots,
      shotsOnTarget: Math.floor(shots * (0.3 + Math.random() * 0.4)),
      possession: 40 + Math.floor(Math.random() * 20),
      score: { home: goalsHome, away: goalsAway },
      homeLast6: last6(), awayLast6: last6(),
      final: {
        cornersTotal,
        goalsHome, goalsAway,
      },
      odds: {
        overCorners: 1.75 + Math.random() * 0.35,
        underCorners: 1.85 + Math.random() * 0.30,
        btts: 1.60 + Math.random() * 0.40,
        bttsNo: 1.95 + Math.random() * 0.35,
        over25: 1.70 + Math.random() * 0.40,
        under25: 1.90 + Math.random() * 0.30,
      },
    });
  }
  return out;
}

module.exports = {
  runBacktest,
  buildSyntheticDataset,
  parseSuggestionLine,
  resolveBet,
};
