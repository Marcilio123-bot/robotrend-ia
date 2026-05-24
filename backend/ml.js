/**
 * Robotrend IA — Camada ML / Calibração
 *
 *  - Pesos por liga (leagueWeights) — leagues mais previsíveis ganham boost
 *  - Anti-Fake-Pressure: descarta picos artificiais (ex: ataques perigosos
 *    subindo sem chutes/escanteios — comum em providers que inflam stats)
 *  - Confiabilidade da partida (matchReliability) — derrubada de cards "fakes"
 *  - Autotune: ajusta SIGNAL_MIN_SCORE com base em winrate histórico
 *
 *  Em produção, este módulo pode ser substituído por um modelo treinado
 *  (ex: lightgbm exportado via onnx). Aqui mantemos a interface estável.
 */

'use strict';

const antifake = require('./antifake');

const LEAGUE_WEIGHTS = {
  // ligas mais consistentes (boost de confiança)
  'Premier League':        1.08,
  'La Liga':               1.06,
  'Serie A Italiana':      1.06,
  'Bundesliga':            1.05,
  'Brasileirão Série A':   1.05,
  'Champions League':      1.04,
  // ligas voláteis
  'Libertadores':          0.97,
  'Copa do Brasil':        0.96,
};

const MINUTE_WEIGHTS = [
  // segmento -> multiplicador (preferimos sinais no fim do jogo p/ corners)
  { from: 0,  to: 14,  mul: 0.85 },
  { from: 15, to: 29,  mul: 0.95 },
  { from: 30, to: 44,  mul: 1.0  },
  { from: 45, to: 59,  mul: 1.05 },
  { from: 60, to: 74,  mul: 1.12 }, // janela de ouro
  { from: 75, to: 90,  mul: 1.08 },
];

const ANTI_FAKE = String(process.env.ANTI_FAKE_PRESSURE || 'true').toLowerCase() === 'true';
const AUTOTUNE  = String(process.env.ML_AUTOTUNE || 'true').toLowerCase() === 'true';

function leagueWeight(league) {
  if (!league) return 1.0;
  if (LEAGUE_WEIGHTS[league] !== undefined) return LEAGUE_WEIGHTS[league];
  // partial match (case-insensitive)
  const k = Object.keys(LEAGUE_WEIGHTS).find((x) =>
    league.toLowerCase().includes(x.toLowerCase())
  );
  return k ? LEAGUE_WEIGHTS[k] : 1.0;
}

function minuteWeight(minute) {
  const m = Number(minute || 0);
  const seg = MINUTE_WEIGHTS.find((s) => m >= s.from && m <= s.to);
  return seg ? seg.mul : 1.0;
}

/**
 * Anti-Fake-Pressure (delega para o módulo dedicado v2 — multi-camada)
 */
function antiFakePressure(match, history = []) {
  if (!ANTI_FAKE) return { fake: false, flags: [], reasons: [], score: 0, reliability: 1 };
  return antifake.analyze(match, history);
}

/**
 * Confiabilidade da partida — usa o antifake v2.
 */
function matchReliability(match, history = []) {
  const af = antiFakePressure(match, history);
  let r = af.reliability;
  if (history.length >= 5) r *= 1.05;
  if (Number(match.minute || 0) < 20) r *= 0.85;
  return Math.min(1.0, Math.max(0.2, r));
}

/**
 * Aplica calibração final sobre a confiança IA.
 *  - leagueWeight x minuteWeight x reliability
 */
function calibrate(rawConfidence, ctx = {}) {
  const lw = leagueWeight(ctx.league);
  const mw = minuteWeight(ctx.minute);
  const rel = ctx.reliability !== undefined ? ctx.reliability : 1.0;
  const adjusted = rawConfidence * lw * mw * rel;
  return Math.max(0, Math.min(100, Math.round(adjusted)));
}

/**
 * Autotune do limite de sinal com base em winrate histórico.
 * @param {number} baseMin - SIGNAL_MIN_SCORE atual
 * @param {object} stats   - { winrate, sent, wins, losses }
 */
function autoTuneMinScore(baseMin, stats) {
  if (!AUTOTUNE || !stats || (stats.wins + stats.losses) < 20) return baseMin;
  const wr = stats.winrate || 0;
  if (wr < 50) return Math.min(95, baseMin + 5);   // aumenta corte
  if (wr > 75) return Math.max(70, baseMin - 3);   // relaxa corte
  return baseMin;
}

/**
 * State adaptativo — pode ser atualizado em runtime com weights do quality
 * tracker (dinâmicos). Mantemos um buffer simples.
 */
const ADAPTIVE_STATE = {
  leaguesOverride: {},   // ex: { 'Premier League': 1.12 }
  hoursOverride:   {},   // ex: { '18-23': 1.05 }
  marketMinScore:  {},   // ex: { 'Escanteios': 78, 'BTTS': 82 }
  lastUpdate:      null,
};

function applyAdaptiveWeights(qualityWeights = {}, marketMinScores = {}) {
  if (qualityWeights.leagues) ADAPTIVE_STATE.leaguesOverride = qualityWeights.leagues;
  if (qualityWeights.hours)   ADAPTIVE_STATE.hoursOverride   = qualityWeights.hours;
  if (marketMinScores)        ADAPTIVE_STATE.marketMinScore  = marketMinScores;
  ADAPTIVE_STATE.lastUpdate = new Date().toISOString();
}

function adaptiveLeagueWeight(league) {
  const dyn = league && ADAPTIVE_STATE.leaguesOverride[league];
  return dyn || leagueWeight(league);
}

function hourWeight(date) {
  const h = new Date(date || Date.now()).getHours();
  const bucket = h < 6 ? '00-05' : h < 12 ? '06-11' : h < 18 ? '12-17' : '18-23';
  return ADAPTIVE_STATE.hoursOverride[bucket] || 1.0;
}

function marketMinScore(market, fallback) {
  return ADAPTIVE_STATE.marketMinScore[market] || fallback;
}

/**
 * Análise reforçada — recebe o resultado do analyzer e aplica camadas ML.
 */
function reinforce(signal, ctx = {}) {
  const match = ctx.match || signal.snapshot || {};
  const history = ctx.history || [];
  const af = antiFakePressure(match, history);
  const reliability = matchReliability(match, history);
  const hw = hourWeight(signal.createdAt);

  const calibrated = Math.round(
    Math.max(0, Math.min(100,
      (signal.confidence || 0)
        * adaptiveLeagueWeight(signal.league)
        * minuteWeight(signal.minute)
        * hw
        * reliability
    ))
  );

  return {
    ...signal,
    confidence: calibrated,
    ml: {
      reliability,
      leagueWeight: adaptiveLeagueWeight(signal.league),
      minuteWeight: minuteWeight(signal.minute),
      hourWeight: hw,
      antiFake: af,
      adaptive: !!ADAPTIVE_STATE.lastUpdate,
    },
  };
}

module.exports = {
  reinforce,
  calibrate,
  autoTuneMinScore,
  matchReliability,
  antiFakePressure,
  leagueWeight,
  minuteWeight,
  applyAdaptiveWeights,
  marketMinScore,
  ADAPTIVE_STATE,
  LEAGUE_WEIGHTS,
};
