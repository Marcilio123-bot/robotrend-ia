/**
 * Robotrend IA — Anti-Fake-Pressure AVANÇADO
 *
 *   Camadas de detecção:
 *     A) Phantom attacks  → ataques perigosos sem chutes/escanteios
 *     B) Posse improdutiva→ posse alta + finalizações baixas
 *     C) Ritmo enganoso   → corners não convertem (pressão sem perigo real)
 *     D) Domínio fake     → defendendo sem proporcionalidade
 *     E) Stat noise       → variações absurdas entre snapshots
 *
 *   Retorna: {
 *     score: 0-100 (quanto maior, mais suspeito),
 *     fake: boolean,
 *     flags: string[],
 *     reliability: 0-1
 *   }
 */

'use strict';

const ENABLED = String(process.env.ANTI_FAKE_PRESSURE || 'true').toLowerCase() === 'true';

function detectPhantomAttacks(match) {
  const da = Number(match.dangerousAttacks || 0);
  const shots = Number(match.shots || 0);
  const corners = Number(match.corners || 0);
  const minute = Number(match.minute || 1);

  if (da < 40 || minute < 20) return null;
  const productivity = shots + corners;
  const ratio = productivity ? da / productivity : 99;
  if (ratio > 30 && minute >= 30) {
    return { flag: 'PHANTOM_ATTACKS', weight: 25, reason: `${da} atq.per. com apenas ${productivity} chutes+esc` };
  }
  if (ratio > 22 && minute >= 50) {
    return { flag: 'PHANTOM_ATTACKS_LIGHT', weight: 12, reason: `Ratio atq/produção alto (${ratio.toFixed(1)})` };
  }
  return null;
}

function detectUnproductivePossession(match) {
  const poss = Number(match.possession || 50);
  const shots = Number(match.shots || 0);
  const onTarget = Number(match.shotsOnTarget || 0);
  const minute = Number(match.minute || 1);

  if (minute < 40) return null;
  if (poss > 65 && shots < 5) {
    return { flag: 'UNPRODUCTIVE_POSSESSION', weight: 20, reason: `Posse ${poss}% mas só ${shots} chutes` };
  }
  if (poss > 70 && onTarget <= 1 && minute >= 60) {
    return { flag: 'STERILE_POSSESSION', weight: 15, reason: `Posse ${poss}% com chutes no alvo ≤ 1` };
  }
  return null;
}

function detectDeceptiveRhythm(match) {
  const corners = Number(match.corners || 0);
  const onTarget = Number(match.shotsOnTarget || 0);
  const minute = Number(match.minute || 1);

  if (minute < 45) return null;
  if (corners >= 8 && onTarget < 2) {
    return { flag: 'DECEPTIVE_RHYTHM', weight: 18, reason: `${corners} escanteios sem converter (alvo<2)` };
  }
  return null;
}

function detectFakeDomination(match) {
  const da = Number(match.dangerousAttacks || 0);
  const poss = Number(match.possession || 50);
  const score = match.score || { home: 0, away: 0 };
  const minute = Number(match.minute || 1);

  if (minute < 60) return null;
  // Time perdendo de 2+ com posse alta e poucas conclusões = pressão de fim de jogo "fake" típica
  const losing = Math.abs(Number(score.home || 0) - Number(score.away || 0)) >= 2;
  if (losing && poss > 60 && da < 50) {
    return { flag: 'FAKE_DOMINATION', weight: 10, reason: 'Time perdendo simula domínio' };
  }
  return null;
}

function detectStatNoise(history) {
  if (!Array.isArray(history) || history.length < 3) return null;
  const last = history[history.length - 1];
  const prev = history[history.length - 2];
  if (!last || !prev) return null;
  const deltaDA    = Math.abs((last.dangerousAttacks || 0) - (prev.dangerousAttacks || 0));
  const deltaTime  = Math.max(1, (last.minute || 0) - (prev.minute || 0));
  if (deltaDA / deltaTime > 25) {
    return { flag: 'STAT_NOISE', weight: 8, reason: `+${deltaDA} atq.per. em ${deltaTime}min (variação absurda)` };
  }
  return null;
}

/**
 * Análise completa.
 */
function analyze(match, history = []) {
  if (!ENABLED) {
    return { score: 0, fake: false, flags: [], reliability: 1.0, reasons: [] };
  }

  const results = [
    detectPhantomAttacks(match),
    detectUnproductivePossession(match),
    detectDeceptiveRhythm(match),
    detectFakeDomination(match),
    detectStatNoise(history),
  ].filter(Boolean);

  const totalWeight = results.reduce((s, r) => s + r.weight, 0);
  const score = Math.min(100, totalWeight);
  const fake = score >= 30;
  const reliability = Math.max(0.25, 1 - score / 130);

  return {
    score,
    fake,
    flags: results.map((r) => r.flag),
    reasons: results.map((r) => `${r.flag}: ${r.reason}`),
    reliability: +reliability.toFixed(2),
  };
}

module.exports = { analyze };
