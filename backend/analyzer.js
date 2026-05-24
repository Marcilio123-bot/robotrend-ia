/**
 * Robotrend IA — Motor de Decisão v2 PREMIUM
 *
 *   +20 ataques perigosos altos
 *   +15 finalizações altas
 *   +10 escanteios altos
 *   -10 jogo lento
 *   -15 baixa pressão
 *
 *   + Risk classification (LOW/MEDIUM/HIGH)
 *   + Odd estimada (Kelly-friendly)
 *   + Classificação visual HOT/WARM/COLD/DANGER
 */

'use strict';

const { analyzeCorners } = require('./corners');
const { analyzeBtts } = require('./btts');
const freshness = require('./freshness');

const DEFAULT_MIN_SCORE = Number(process.env.SIGNAL_MIN_SCORE || 80);

const ENV = process.env.NODE_ENV || 'development';
const STRICT_REAL_ONLY = (() => {
  const raw = process.env.STRICT_REAL_ONLY;
  if (raw == null || raw === '') return ENV === 'production' || ENV === 'staging';
  return String(raw).toLowerCase() === 'true';
})();

function cornerScore(match) {
  let score = 0;
  const reasons = [];

  if (match.dangerousAttacks >= 70) { score += 20; reasons.push('+20 ataques perigosos altos'); }
  else if (match.dangerousAttacks >= 50) { score += 10; reasons.push('+10 ataques perigosos médios'); }

  if (match.shots >= 15) { score += 15; reasons.push('+15 finalizações altas'); }
  else if (match.shots >= 10) { score += 8; reasons.push('+8 finalizações médias'); }

  if (match.corners >= 8) { score += 10; reasons.push('+10 escanteios altos'); }
  else if (match.corners >= 5) { score += 5; reasons.push('+5 escanteios médios'); }

  if (match.dangerousAttacks < 30 && match.minute >= 45) { score -= 10; reasons.push('-10 jogo lento'); }
  if (match.shotsOnTarget !== undefined && match.shotsOnTarget < 2 && match.minute >= 45) {
    score -= 15; reasons.push('-15 baixa pressão');
  }
  if (match.minute >= 65 && match.corners >= 7) { score += 10; reasons.push('+10 jogo final com volume'); }

  return { score, reasons };
}

/**
 * Estima a odd justa para a entrada com base na confiança IA.
 * confidence -> probabilidade implícita -> odd (margin 5%).
 */
function estimateOdd(confidence) {
  const prob = Math.max(0.5, Math.min(0.97, confidence / 100));
  const fair = 1 / prob;
  return +(fair * 1.05).toFixed(2);
}

/**
 * Classificação de risco com base em score + confiança.
 *  LOW    🟢 confidence >= 88
 *  MEDIUM 🟡 confidence >= 75
 *  HIGH   🔴 confidence < 75
 */
function classifyRisk(confidence) {
  if (confidence >= 88) return { level: 'LOW',    emoji: '🟢', label: 'BAIXO' };
  if (confidence >= 75) return { level: 'MEDIUM', emoji: '🟡', label: 'MÉDIO' };
  return                    { level: 'HIGH',   emoji: '🔴', label: 'ALTO' };
}

function analyzeLiveMatch(match, options = {}) {
  const minScore = options.minScore || DEFAULT_MIN_SCORE;
  const history = options.history || [];

  // STRICT: analyzer recusa qualquer match sem origem LIVE API real.
  // Pressão, momentum e intensidade SÓ podem vir de dados confirmados.
  if (STRICT_REAL_ONLY && !options.skipFreshness && !options.skipSourceCheck) {
    const src = freshness.checkSignalSource(match);
    if (!src.ok) {
      return {
        matchId: match?.id,
        home: match?.home,
        away: match?.away,
        league: match?.league,
        minute: match?.minute,
        market: 'Escanteios',
        verdict: '⛔ Match não confirmado pela API live',
        suggestion: null,
        confidence: 0,
        shouldSignal: false,
        stale: true,
        staleReason: `source-guard: ${src.reason}`,
        createdAt: new Date().toISOString(),
      };
    }
  }

  // Guard de frescor (backtest pula via options.skipFreshness)
  if (!options.skipFreshness) {
    const fresh = freshness.checkMatch(match);
    if (!fresh.ok) {
      return {
        matchId: match?.id,
        home: match?.home,
        away: match?.away,
        league: match?.league,
        minute: match?.minute,
        market: 'Escanteios',
        verdict: '⛔ Partida fora da janela',
        suggestion: null,
        confidence: 0,
        shouldSignal: false,
        stale: true,
        staleReason: fresh.reason,
        snapshot: { corners: match?.corners, dangerousAttacks: match?.dangerousAttacks,
                    shots: match?.shots, shotsOnTarget: match?.shotsOnTarget,
                    possession: match?.possession, score: match?.score },
        createdAt: new Date().toISOString(),
      };
    }
  }

  const cornersAnalysis = analyzeCorners(match, history);
  const { score, reasons } = cornerScore(match);

  const finalScore = Math.max(
    0,
    Math.min(100, Math.round(score + cornersAnalysis.confidence * 0.5))
  );
  const shouldSignal = finalScore >= minScore && Boolean(cornersAnalysis.suggestion);
  const risk = classifyRisk(finalScore);
  const odd = estimateOdd(finalScore);

  return {
    matchId: match.id,
    home: match.home,
    away: match.away,
    league: match.league,
    minute: match.minute,
    market: 'Escanteios',
    verdict: cornersAnalysis.verdict,
    suggestion: cornersAnalysis.suggestion,
    asianLine: cornersAnalysis.asianLine,
    confidence: finalScore,
    rawScore: score,
    reasons,
    pressure: cornersAnalysis.pressure,
    intensity: cornersAnalysis.intensity,
    pressurePerMinute: cornersAnalysis.pressurePerMinute,
    momentum: cornersAnalysis.momentum,
    classification: cornersAnalysis.classification,
    projected: cornersAnalysis.projected,
    rate: cornersAnalysis.rate,
    tags: cornersAnalysis.tags,
    risk,
    odd,
    shouldSignal,
    snapshot: {
      corners: match.corners,
      dangerousAttacks: match.dangerousAttacks,
      shots: match.shots,
      shotsOnTarget: match.shotsOnTarget,
      possession: match.possession,
      score: match.score,
    },
    createdAt: new Date().toISOString(),
  };
}

function analyzePrelive(fixture, options = {}) {
  // Pré-live só aceita jogos futuros (próximas 24h) — backtest pula
  if (!options.skipFreshness && fixture && fixture.startsAt && !freshness.isUpcomingMatch(fixture)) {
    return {
      matchId: fixture.id,
      home: fixture.home,
      away: fixture.away,
      league: fixture.league,
      startsAt: fixture.startsAt,
      market: 'BTTS',
      verdict: '⛔ Fixture fora da janela',
      suggestion: null,
      confidence: 0,
      shouldSignal: false,
      stale: true,
      createdAt: new Date().toISOString(),
    };
  }

  const btts = analyzeBtts({
    home: fixture.home,
    away: fixture.away,
    homeLast6: fixture.homeLast6 || [],
    awayLast6: fixture.awayLast6 || [],
  });

  const shouldSignal =
    btts.confidence >= 75 && btts.suggestion && btts.suggestion.includes('SIM');
  const risk = classifyRisk(btts.confidence);
  const odd = estimateOdd(btts.confidence);

  return {
    matchId: fixture.id,
    home: fixture.home,
    away: fixture.away,
    league: fixture.league,
    startsAt: fixture.startsAt,
    market: 'BTTS',
    verdict: btts.verdict,
    suggestion: btts.suggestion,
    confidence: btts.confidence,
    tags: btts.tags,
    homeStats: btts.home,
    awayStats: btts.away,
    over25: btts.over25,
    offensiveCombined: btts.offensiveCombined,
    risk,
    odd,
    shouldSignal,
    createdAt: new Date().toISOString(),
  };
}

module.exports = {
  analyzeLiveMatch,
  analyzePrelive,
  cornerScore,
  classifyRisk,
  estimateOdd,
};
