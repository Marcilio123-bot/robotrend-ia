/**
 * Robotrend IA — Módulo Ambas Marcam (BTTS) — v2 PREMIUM
 *
 * Calcula:
 *  - BTTS (sim/não) com porcentagem de confiança
 *  - Over 2.5 automático (com base na média combinada de gols)
 *  - Índice ofensivo do confronto (0-100)
 *  - Histórico visual dos últimos 6 jogos (para mini-gráfico)
 */

'use strict';

const LAST_N = 6;

function avg(arr) {
  if (!arr || !arr.length) return 0;
  const sum = arr.reduce((a, b) => a + Number(b || 0), 0);
  return +(sum / arr.length).toFixed(2);
}

function countBtts(matches) {
  if (!Array.isArray(matches)) return 0;
  return matches.filter(
    (m) => Number(m.goalsFor) > 0 && Number(m.goalsAgainst) > 0
  ).length;
}

function countScored(matches) {
  if (!Array.isArray(matches)) return 0;
  return matches.filter((m) => Number(m.goalsFor) > 0).length;
}

function countConceded(matches) {
  if (!Array.isArray(matches)) return 0;
  return matches.filter((m) => Number(m.goalsAgainst) > 0).length;
}

/**
 * Quantos jogos foram acima de 2.5 gols.
 */
function countOver25(matches) {
  if (!Array.isArray(matches)) return 0;
  return matches.filter(
    (m) => Number(m.goalsFor || 0) + Number(m.goalsAgainst || 0) > 2.5
  ).length;
}

/**
 * Histórico visual dos 6 jogos — array com flags por mini-gráfico no painel.
 * Cada item:
 *   { goalsFor, goalsAgainst, total, btts: bool, over25: bool, win: 'W'|'D'|'L' }
 */
function buildHistory(matches) {
  if (!Array.isArray(matches)) return [];
  return matches.slice(0, LAST_N).map((m) => {
    const gf = Number(m.goalsFor || 0);
    const ga = Number(m.goalsAgainst || 0);
    const total = gf + ga;
    return {
      goalsFor: gf,
      goalsAgainst: ga,
      total,
      btts: gf > 0 && ga > 0,
      over25: total > 2.5,
      result: gf > ga ? 'W' : gf < ga ? 'L' : 'D',
    };
  });
}

function teamStats(matches) {
  const safe = Array.isArray(matches) ? matches.slice(0, LAST_N) : [];
  const scoredCount = countScored(safe);
  const concededCount = countConceded(safe);
  const bttsCount = countBtts(safe);
  const over25Count = countOver25(safe);
  const offensiveIndex = Math.round(
    Math.min(avg(safe.map((m) => m.goalsFor)) / 2.5, 1) * 60 +
      Math.min(scoredCount / 6, 1) * 40
  );
  return {
    games: safe.length,
    avgScored: avg(safe.map((m) => m.goalsFor)),
    avgConceded: avg(safe.map((m) => m.goalsAgainst)),
    avgShots: avg(safe.map((m) => m.shots || 0)),
    scoredCount,
    concededCount,
    bttsCount,
    over25Count,
    scoredPct: safe.length ? Math.round((scoredCount / safe.length) * 100) : 0,
    concededPct: safe.length ? Math.round((concededCount / safe.length) * 100) : 0,
    bttsPct: safe.length ? Math.round((bttsCount / safe.length) * 100) : 0,
    over25Pct: safe.length ? Math.round((over25Count / safe.length) * 100) : 0,
    offensiveIndex,
    history: buildHistory(safe),
  };
}

function analyzeBtts(input) {
  const home = teamStats(input.homeLast6);
  const away = teamStats(input.awayLast6);

  let score = 0;
  const tags = [];

  if (home.scoredCount >= 5) { score += 20; tags.push(`${input.home} marcou em ${home.scoredCount}/6`); }
  if (away.scoredCount >= 5) { score += 20; tags.push(`${input.away} marcou em ${away.scoredCount}/6`); }
  if (home.concededCount >= 4) { score += 12; tags.push(`${input.home} sofreu em ${home.concededCount}/6`); }
  if (away.concededCount >= 4) { score += 12; tags.push(`${input.away} sofreu em ${away.concededCount}/6`); }
  if (home.bttsCount >= 4 && away.bttsCount >= 4) { score += 15; tags.push('BTTS frequente em ambos'); }
  if (home.avgScored + away.avgScored >= 3) { score += 10; tags.push('Média ofensiva combinada alta'); }
  if (home.avgShots >= 12 || away.avgShots >= 12) { score += 5; tags.push('Volume de finalizações'); }

  if (home.scoredCount <= 2 || away.scoredCount <= 2) { score -= 20; tags.push('Equipe com baixo poder ofensivo'); }
  if (home.concededCount <= 1 && away.concededCount <= 1) { score -= 15; tags.push('Defesas muito sólidas'); }

  const confidence = Math.max(0, Math.min(100, score + 50));

  let verdict;
  let suggestion;
  if (confidence >= 75) {
    verdict = '✅ FORTE TENDÊNCIA PARA AMBAS MARCAM';
    suggestion = 'BTTS — SIM';
  } else if (confidence >= 60) {
    verdict = 'TENDÊNCIA MODERADA PARA AMBAS MARCAM';
    suggestion = 'BTTS — SIM (cautela)';
  } else if (confidence <= 30) {
    verdict = '❌ BAIXA PROBABILIDADE DE BTTS';
    suggestion = 'BTTS — NÃO';
  } else {
    verdict = 'CENÁRIO NEUTRO';
    suggestion = null;
  }

  // Over 2.5 automático
  const combinedAvgGoals = +(home.avgScored + away.avgScored + (home.avgConceded + away.avgConceded) / 2).toFixed(2);
  const over25Pct = Math.round((home.over25Pct + away.over25Pct) / 2);
  let over25Verdict = null;
  let over25Suggestion = null;
  if (combinedAvgGoals >= 3 && over25Pct >= 65) {
    over25Verdict = '🎯 ALTA TENDÊNCIA OVER 2.5';
    over25Suggestion = 'Over 2.5 Gols';
  } else if (combinedAvgGoals <= 1.7 && over25Pct <= 35) {
    over25Verdict = '🛡️ TENDÊNCIA UNDER 2.5';
    over25Suggestion = 'Under 2.5 Gols';
  }

  const offensiveCombined = Math.round((home.offensiveIndex + away.offensiveIndex) / 2);

  return {
    market: 'BTTS',
    verdict,
    suggestion,
    confidence,
    tags,
    home: { name: input.home, ...home },
    away: { name: input.away, ...away },
    over25: {
      verdict: over25Verdict,
      suggestion: over25Suggestion,
      combinedAvgGoals,
      historyPct: over25Pct,
    },
    offensiveCombined,
  };
}

module.exports = {
  analyzeBtts,
  teamStats,
  buildHistory,
  countBtts,
  countScored,
  countConceded,
  countOver25,
};
