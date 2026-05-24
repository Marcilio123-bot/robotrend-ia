/**
 * Robotrend IA — Módulo de Análise de Escanteios (LIVE) — v2 PREMIUM
 *
 * Métricas avançadas:
 *  - momentum (tendência últimos 10')
 *  - intensidade ofensiva combinada
 *  - pressão por minuto
 *  - classificação visual HOT 🔥 / WARM ⚡ / COLD ❄️ / DANGER 🚨
 *  - projeção full-time
 */

'use strict';

function cornersPerMinute(corners, minute) {
  if (!minute || minute <= 0) return 0;
  return +(corners / minute).toFixed(3);
}

function projectFullTimeCorners(corners, minute) {
  if (!minute || minute <= 0) return corners;
  const rate = corners / minute;
  return Math.round(rate * 90 * 10) / 10;
}

function pressureIndex(stats) {
  const dangerous = Number(stats.dangerousAttacks || 0);
  const shots = Number(stats.shots || 0);
  const shotsOn = Number(stats.shotsOnTarget || 0);
  const possession = Number(stats.possession || 50);

  const dangerScore = Math.min(dangerous / 100, 1) * 45;
  const shotsScore = Math.min(shots / 25, 1) * 30;
  const onTargetScore = Math.min(shotsOn / 10, 1) * 15;
  const possScore = (Math.abs(possession - 50) / 50) * 10;

  return Math.round(dangerScore + shotsScore + onTargetScore + possScore);
}

/**
 * Intensidade ofensiva combinada (0-100).
 * Combina chutes + ataques perigosos + escanteios — peso para "produção" final.
 */
function intensityIndex(stats) {
  const shots = Number(stats.shots || 0);
  const dangerous = Number(stats.dangerousAttacks || 0);
  const corners = Number(stats.corners || 0);

  return Math.round(
    Math.min(shots / 20, 1) * 40 +
      Math.min(dangerous / 100, 1) * 40 +
      Math.min(corners / 12, 1) * 20
  );
}

/**
 * Pressão por minuto: quanto "está acontecendo" por minuto da partida.
 */
function pressurePerMinute(stats) {
  const minute = Number(stats.minute || 0);
  if (minute <= 0) return 0;
  const total =
    Number(stats.dangerousAttacks || 0) * 0.4 +
    Number(stats.shots || 0) * 1.5 +
    Number(stats.corners || 0) * 2;
  return +(total / minute).toFixed(2);
}

/**
 * Momentum (tendência últimos 10'). Recebe um array com snapshots
 * históricos { minute, corners, shots, dangerousAttacks }. Se não há
 * histórico, derivamos uma estimativa a partir de stats atuais.
 * Retorna { delta, label, score (0-100) }.
 */
function momentumIndex(current, history) {
  if (!Array.isArray(history) || history.length < 2) {
    const intensity = intensityIndex(current);
    return {
      delta: 0,
      score: intensity,
      label: intensity > 65 ? 'SUBINDO' : intensity > 40 ? 'NEUTRO' : 'CAINDO',
    };
  }
  const last = history[history.length - 1];
  const tenAgo = history.find((h) => current.minute - h.minute <= 10) || history[0];

  const deltaDangerous = (last.dangerousAttacks || 0) - (tenAgo.dangerousAttacks || 0);
  const deltaShots = (last.shots || 0) - (tenAgo.shots || 0);
  const deltaCorners = (last.corners || 0) - (tenAgo.corners || 0);

  const raw = deltaDangerous * 0.5 + deltaShots * 3 + deltaCorners * 5;
  const score = Math.max(0, Math.min(100, Math.round(50 + raw)));
  return {
    delta: raw,
    score,
    label: raw > 8 ? 'SUBINDO' : raw < -4 ? 'CAINDO' : 'NEUTRO',
  };
}

/**
 * Classificação visual baseada em pressão + momentum + minuto.
 * - HOT    🔥  pressão alta + momentum subindo no fim do jogo
 * - WARM   ⚡  pressão moderada
 * - COLD   ❄️  jogo morno
 * - DANGER 🚨  alerta de virada de tendência (pressão sobe rápido)
 */
function classifyMatch(stats, pressure, momentum) {
  if (pressure >= 70 && momentum.label === 'SUBINDO' && stats.minute >= 60) {
    return { level: 'HOT', emoji: '🔥', label: 'PRESSÃO MÁXIMA' };
  }
  if (pressure >= 60 && momentum.label !== 'CAINDO') {
    return { level: 'HOT', emoji: '🔥', label: 'ATAQUE INTENSO' };
  }
  if (pressure >= 40) {
    return { level: 'WARM', emoji: '⚡', label: 'JOGO LIGADO' };
  }
  if (pressure < 25 && stats.minute >= 45) {
    return { level: 'COLD', emoji: '❄️', label: 'JOGO FRIO' };
  }
  if (momentum.label === 'SUBINDO' && momentum.score >= 70) {
    return { level: 'DANGER', emoji: '🚨', label: 'VIRADA EM CURSO' };
  }
  return { level: 'WARM', emoji: '⚡', label: 'NORMAL' };
}

/**
 * Analisa o cenário de escanteios de uma partida ao vivo.
 *
 * @param {object} match
 * @param {Array}  [history] - snapshots passados (opcional)
 * @returns {object}
 */
function analyzeCorners(match, history) {
  const minute = Number(match.minute || 0);
  const corners = Number(match.corners || 0);
  const projected = projectFullTimeCorners(corners, minute);
  const rate = cornersPerMinute(corners, minute);
  const pressure = pressureIndex(match);
  const intensity = intensityIndex(match);
  const ppm = pressurePerMinute(match);
  const momentum = momentumIndex(match, history);
  const classification = classifyMatch(match, pressure, momentum);

  const tags = [];
  let score = 0;

  if (match.dangerousAttacks >= 70) { tags.push('Ataques perigosos altos'); score += 20; }
  if (match.shots >= 15)             { tags.push('Finalizações altas');     score += 15; }
  if (corners >= 8)                  { tags.push('Volume de escanteios');   score += 10; }
  if (rate >= 0.16)                  { tags.push('Ritmo intenso');          score += 10; }
  if (pressure >= 70)                { tags.push('Pressão ofensiva alta');  score += 15; }
  if (minute >= 60 && pressure >= 65) { tags.push('Final de jogo quente'); score += 10; }
  if (momentum.label === 'SUBINDO')  { tags.push('Momentum subindo');       score += 8; }
  if (match.dangerousAttacks < 30 && minute >= 45) { tags.push('Jogo morno'); score -= 15; }
  if (pressure < 30)                 { tags.push('Baixa pressão');          score -= 10; }
  if (momentum.label === 'CAINDO')   { tags.push('Ritmo caindo');           score -= 8; }

  let verdict = 'NEUTRO';
  let suggestion = null;
  let asianLine = null;

  if (
    minute > 60 &&
    match.dangerousAttacks >= 70 &&
    match.shots >= 15 &&
    corners >= 8
  ) {
    verdict = '🔥 PRESSÃO FORTE DETECTADA';
    suggestion = `Over ${Math.floor(projected) + 0.5} Escanteios`;
    asianLine = `Linha asiática: ${Math.floor(projected) + 0.25}`;
    score += 15;
  } else if (projected >= 11 && rate >= 0.14) {
    verdict = 'TENDÊNCIA OVER';
    suggestion = `Over ${Math.floor(projected) - 0.5} Escanteios`;
    asianLine = `Linha asiática: ${Math.floor(projected) - 0.75}`;
  } else if (projected <= 7 && minute >= 30) {
    verdict = 'TENDÊNCIA UNDER';
    suggestion = `Under ${Math.ceil(projected) + 0.5} Escanteios`;
    asianLine = `Linha asiática: ${Math.ceil(projected) + 0.25}`;
    score += 5;
  } else if (pressure < 30 && minute >= 45) {
    verdict = 'JOGO FRIO';
  }

  const confidence = Math.max(0, Math.min(100, score + 50));

  return {
    verdict,
    tags,
    confidence,
    projected,
    rate,
    pressure,
    intensity,
    pressurePerMinute: ppm,
    momentum,
    classification,
    asianLine,
    suggestion,
  };
}

module.exports = {
  analyzeCorners,
  pressureIndex,
  intensityIndex,
  pressurePerMinute,
  momentumIndex,
  classifyMatch,
  cornersPerMinute,
  projectFullTimeCorners,
};
