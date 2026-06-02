/**
 * Robotrend IA — Bet Signal Engine v1
 *
 * Motor de sinais focado em VALOR (value betting) para 3 mercados:
 *
 *   1. CORNERS   — Over X.5 escanteios (projeção via ritmo + ataques)
 *   2. BTTS      — Ambas marcam: Sim / Não (probabilidade Poisson)
 *   3. WIN (1X2) — Vitória home / Empate / Vitória away (1X2 baseado em xG)
 *
 * REGRAS GERAIS:
 *   - ZERO chamadas externas de API. Lê apenas `poller.getMatches()` e os
 *     dados já enriquecidos no cache (stats, perMinute, score, etc).
 *   - Tick periódico (default 90s = 1.5min, entre 1–2min como pedido).
 *   - Emite signal:new no event bus → footballRealtime broadcasta no socket.
 *   - Filtros obrigatórios antes de emitir:
 *       confidence  >= 70%
 *       oddEstimada in [1.80, 2.20]    (zona de valor / payoff "honesto")
 *       minuto      in [20, 85]         (descarta começo/recta-final ruidoso)
 *   - Cooldown por (matchId × market) — não repete o mesmo sinal por 10min.
 *
 * SAÍDA POR SINAL:
 *   {
 *     type: 'bet:opportunity',
 *     market: 'corners' | 'btts' | 'win',
 *     prediction: 'Over 9.5 escanteios' | 'Ambas marcam: Sim' | 'Vitória Flamengo',
 *     probability: 0..100,           // P(outcome) estimada pelo modelo
 *     confidence:  0..100,           // qualidade do sinal (corroboração, sample)
 *     oddEstimated: 1.80..2.20,      // = 1 / (probability/100), arredondado
 *     justification: 'texto curto explicando os números',
 *     match: { id, home, away, league, minute, score, ... },
 *     extras: { ...detalhes específicos do mercado... },
 *     createdAt: ISO
 *   }
 *
 * PROBABILITY vs CONFIDENCE:
 *   - `probability` é o que o modelo acha que vai acontecer (P do outcome).
 *   - `confidence`  é o quão confiável é essa probabilidade (quanto de dado,
 *     corroboração entre indicadores, estágio do jogo).
 *   - Filtrar por confidence >= 70 + odd 1.80–2.20 = "picks na zona de valor
 *     onde temos alta convicção". Esse é o ângulo de value betting.
 */

'use strict';

const events = require('./footballEvents');
const metrics = require('./metrics');
const { getPoller } = require('../workers/liveFootballPoller');
const { logger } = require('../logger');

const log = logger.child({ module: 'betSignalEngine' });

/* ============================================================
   CONFIG
   ------------------------------------------------------------
   DEBUG / TEST MODES:
     BET_SIGNAL_DEBUG=true       → log verboso por decisão + payload de drops
     BET_SIGNAL_TEST_MODE=true   → afrouxa TODOS os filtros para diagnóstico:
       minConfidence → BET_SIGNAL_TEST_MIN_CONFIDENCE (default 70)
       oddRange      → [1.20, 10.0]  (era [1.80, 2.20])
       minuteRange   → [1, 120]      (era [20, 85])
       cooldown      → 0             (sem cooldown)
       enrichedGate  → IGNORADO      (processa parciais também)
     Use apenas para validar funcionamento. NÃO use em produção.
   ============================================================ */
const ENABLED        = String(process.env.BET_SIGNAL_ENABLED || 'true').toLowerCase() !== 'false';
const TICK_MS        = Number(process.env.BET_SIGNAL_TICK_MS         || 90_000);

// === MODOS DIAGNÓSTICO ===========================================
const DEBUG_MODE     = String(process.env.BET_SIGNAL_DEBUG     || 'false').toLowerCase() === 'true';
// PIPELINE_LOG default = true (logs [LIVE PIPELINE] sempre).
// Defina LIVE_SIGNAL_DEBUG=false no Render para silenciar quando estiver estável.
const PIPELINE_LOG   = DEBUG_MODE || String(process.env.LIVE_SIGNAL_DEBUG || 'true').toLowerCase() === 'true';
const TEST_MODE      = String(process.env.BET_SIGNAL_TEST_MODE || 'false').toLowerCase() === 'true';
const TEST_MIN_CONF  = Number(process.env.BET_SIGNAL_TEST_MIN_CONFIDENCE || 70);

// Tier FREE (entrada baixa, sinais mais amplos)
const FREE_MIN_CONFIDENCE    = Number(process.env.BET_SIGNAL_FREE_MIN_CONFIDENCE    || 65);
// Tier PREMIUM (qualidade — só sinais fortes)
const PREMIUM_MIN_CONFIDENCE = Number(process.env.BET_SIGNAL_PREMIUM_MIN_CONFIDENCE || 75);
// Compat: MIN_CONFIDENCE = piso geral para emitir (= FREE).
// Em TEST_MODE força o piso para TEST_MIN_CONF (default 70).
const MIN_CONFIDENCE = TEST_MODE
  ? TEST_MIN_CONF
  : Math.min(FREE_MIN_CONFIDENCE, Number(process.env.BET_SIGNAL_MIN_CONFIDENCE || FREE_MIN_CONFIDENCE));

const MIN_ODD        = TEST_MODE ? 1.20 : Number(process.env.BET_SIGNAL_MIN_ODD || 1.80);
const MAX_ODD        = TEST_MODE ? 10.0 : Number(process.env.BET_SIGNAL_MAX_ODD || 2.20);
const COOLDOWN_MS    = TEST_MODE ? 0    : Number(process.env.BET_SIGNAL_COOLDOWN_MS || 10 * 60_000);
const MIN_MINUTE     = TEST_MODE ? 1    : Number(process.env.BET_SIGNAL_MIN_MINUTE  || 20);
const MAX_MINUTE     = TEST_MODE ? 120  : Number(process.env.BET_SIGNAL_MAX_MINUTE  || 85);
const RECENT_MAX     = Number(process.env.BET_SIGNAL_RECENT_MAX      || 200);
const DROPS_MAX      = Number(process.env.BET_SIGNAL_DROPS_MAX       || 100);

// Janela em que a "melhor aposta do momento" continua válida (default 8min)
const BEST_TTL_MS    = Number(process.env.BET_SIGNAL_BEST_TTL_MS     || 8 * 60_000);
// Tempo que sinais FREE ficam "engasgados" antes de chegar no socket
// (PREMIUM recebe instantâneo — esse delay é a vantagem real)
const FREE_DELAY_MS  = Number(process.env.BET_SIGNAL_FREE_DELAY_MS   || 8_000);

/* ============================================================
   MÉTRICAS
   ============================================================ */
const m_processed = metrics.counter('bet_signal_processed_total', 'Matches processados pelo bet engine');
const m_emitted   = metrics.counter('bet_signal_emitted_total',   'Sinais emitidos (bet:opportunity)');
const m_skipped   = metrics.counter('bet_signal_skipped_total',   'Sinais descartados (low-conf / odd-fora / cooldown)');
const m_lat       = metrics.histogram('bet_signal_tick_duration_ms');
const g_recent    = metrics.gauge('bet_signal_recent_count');

/* ============================================================
   STATE
   ============================================================ */
const cooldowns = new Map();  // `${matchId}:${market}` -> ts
const recent = [];            // ring buffer dos últimos sinais

/* ============================================================
   DIAGNÓSTICO — contadores por estágio + amostra de descartes
   ------------------------------------------------------------
   Cada tick zera `tickFunnel`; os totais acumulados ficam em `funnelTotals`.
   `recentDrops` guarda os últimos N motivos de descarte (anel) com
   payload curto explicando POR QUE cada match/sinal foi rejeitado.
   Tudo exposto via GET /api/football/bet-signals/debug.
   ============================================================ */
const FUNNEL_KEYS = [
  'input',                 // matches recebidos do poller
  'no-match',              // m falsy
  'not-enriched',          // !m.enriched
  'no-stats',              // !m.stats
  'minute-out-of-range',
  'computed',              // passou os gates de match → entrou em compute*
  'compute-null',          // compute*Bet() retornou null (sem sinal candidato)
  'low-confidence',
  'odd-out-of-range',
  'cooldown',
  'emitted',
];
function makeCounter() {
  return Object.fromEntries(FUNNEL_KEYS.map((k) => [k, 0]));
}
let tickFunnel = makeCounter();
const funnelTotals = makeCounter();
const recentDrops = []; // ring buffer { ts, stage, reason, match, market, conf?, odd?, snapshot? }

function recordFunnel(stage, delta = 1) {
  tickFunnel[stage] = (tickFunnel[stage] || 0) + delta;
  funnelTotals[stage] = (funnelTotals[stage] || 0) + delta;
}
function recordDrop(payload) {
  recentDrops.unshift({ ts: Date.now(), ...payload });
  if (recentDrops.length > DROPS_MAX) recentDrops.length = DROPS_MAX;
}
function resetTickFunnel() {
  tickFunnel = makeCounter();
}

/* ============================================================
   HELPERS
   ============================================================ */
function n(v) { return Number.isFinite(Number(v)) ? Number(v) : 0; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

/** Converte probabilidade (0..100) em odd decimal (1/p) com 2 casas. */
function probToOdd(p) {
  if (p <= 1) return 99;
  return Math.round((100 / p) * 100) / 100;
}

function canFire(key) {
  const now = Date.now();
  const last = cooldowns.get(key) || 0;
  if (now - last < COOLDOWN_MS) return false;
  cooldowns.set(key, now);
  return true;
}

function matchHeader(m) {
  return {
    id: m.id,
    fixtureId: m.fixtureId,
    home: m.home,
    away: m.away,
    league: m.league?.name || m.league,
    country: m.league?.country,
    minute: m.minute,
    status: m.status,
    score: m.score,
    kickoffAt: m.kickoffAt,
  };
}

/** Massa de probabilidade Poisson(λ) no inteiro k (k >= 0). */
function poisson(lambda, k) {
  if (!Number.isFinite(lambda) || lambda < 0) return k === 0 ? 1 : 0;
  if (lambda === 0) return k === 0 ? 1 : 0;
  // log-space para evitar overflow em λ grande
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

/* ============================================================
   FALLBACK XG — quando stats avançados (corners, dangerousAttacks,
   shotsOnTarget) não estão disponíveis (ENRICH_ENABLED=false ou
   minimal enrichment), derivamos um xG baseline usando apenas
   placar + minuto + posse.
   ------------------------------------------------------------
   Calibração:
     - 1.30 gols/time/90min  ≈ liga média
     - HOME_BUMP = 0.10 (vantagem de mando histórica ~10%)
     - posse modula ±20% nos λ (idêntico ao computeWinBet)
     - placar atual já marcado entra como "xG observado" parcial
   ============================================================ */
// Calibrado para que cenários comuns sem stats (0×0 35-60′, 1×0 40-50′,
// 1×1 75-90′) caiam na janela de odd 1.80-2.20.
const BASELINE_XG_PER_MIN = Number(process.env.BET_SIGNAL_BASELINE_XG_PER_MIN || 0.0180); // ≈ 1.62/90
const BASELINE_HOME_BUMP  = Number(process.env.BET_SIGNAL_BASELINE_HOME_BUMP  || 0.10);

// Taxa base de escanteios — usada SOMENTE quando stats avançados não chegaram
// (ENRICH_ENABLED=false, safeMode, ou /fixtures/statistics falhou). 0.10/min
// ≈ 9 em 90′ (média de liga). Sem isso, computeCornersBet ficava preso em
// "compute-null" silencioso quando corners.total=0.
const BASELINE_CORNERS_PER_MIN = Number(process.env.BET_SIGNAL_BASELINE_CORNERS_PER_MIN || 0.10);

function hasAdvancedStats(m) {
  const s = m?.stats || {};
  const sotH = n(s.shotsOnTarget?.home);
  const sotA = n(s.shotsOnTarget?.away);
  const dangH = n(s.dangerousAttacks?.home);
  const dangA = n(s.dangerousAttacks?.away);
  const cornH = n(s.corners?.home);
  const cornA = n(s.corners?.away);
  return (sotH + sotA + dangH + dangA + cornH + cornA) > 0;
}

/**
 * xG por time baseado SOMENTE em placar + minuto + posse.
 * Usado como fallback inteligente quando stats avançados são zero.
 *  - λ_acumulado ≈ baseline_xg_per_min × min ajustado por posse + placar real
 *  - λ_restante  = baseline_xg_per_min × remaining ajustado por posse
 */
function baselineXG(m) {
  const min = Math.max(1, n(m.minute));
  const remaining = Math.max(0, 95 - min);
  const sh = n(m.score?.home);
  const sa = n(m.score?.away);
  const possH = clamp(n(m.stats?.possession?.home) || 50, 30, 70);
  const possA = 100 - possH;
  const possEdge = (possH - possA) / 100;

  const baseRate = BASELINE_XG_PER_MIN;
  const lamHRest = Math.max(0, baseRate * remaining * (1 + possEdge * 0.20 + BASELINE_HOME_BUMP));
  const lamARest = Math.max(0, baseRate * remaining * (1 - possEdge * 0.20));

  // λ acumulado é "placar real + tendência baseline", clamped no acumulado mínimo
  const lamHAcum = Math.max(sh, baseRate * min * (1 + BASELINE_HOME_BUMP));
  const lamAAcum = Math.max(sa, baseRate * min);

  return {
    lamHRest, lamARest,
    lamHAcum, lamAAcum,
    possH, possA, possEdge,
    sh, sa, min, remaining,
  };
}

/* ============================================================
   1) CORNERS — Over X.5 escanteios
   Lógica: extrapola o ritmo atual, escolhe a linha X.5 cuja projeção
   resulta em P(over) na zona 45–55% (= odd 1.80–2.20).
   Confiança sobe com:
     - minuto avançado (mais sinal, menos ruído)
     - ritmo já elevado (>= 0.20/min)
     - ataques dos DOIS lados (pressão balanceada)
   ============================================================ */
function computeCornersBet(m) {
  const min = Math.max(1, n(m.minute));
  const remaining = Math.max(0, 95 - min);
  const cornH = n(m.stats?.corners?.home);
  const cornA = n(m.stats?.corners?.away);
  const total = cornH + cornA;
  const advanced = hasAdvancedStats(m);
  const dangH = n(m.stats?.dangerousAttacks?.home);
  const dangA = n(m.stats?.dangerousAttacks?.away);
  const dangBal = Math.min(dangH, dangA);
  const pressure = n(m.perMinute?.pressureIndex);
  const sotH = n(m.stats?.shotsOnTarget?.home);
  const sotA = n(m.stats?.shotsOnTarget?.away);
  const sotBal = Math.min(sotH, sotA);

  // [CORNER DEBUG] visibilidade por match — mostra exatamente qual número
  // de corners chegou ao engine vs. o que foi extraído do fixtureNormalizer.
  if (PIPELINE_LOG) {
    console.log(
      `[CORNER DEBUG] fixtureId=${m.fixtureId || m.id} home=${cornH} away=${cornA} total=${total} ` +
      `min=${min} advanced=${advanced} enrichedPartial=${!!m.enrichedPartial}`
    );
  }

  if (remaining < 5) {
    if (PIPELINE_LOG) console.log(`[CORNER DEBUG] DROP no-time | fixtureId=${m.fixtureId || m.id} | min=${min} remaining=${remaining}`);
    return null;
  }

  /* ============================================================
     RATE — taxa atual de corners/min.
     ------------------------------------------------------------
     Se total>0 → usa taxa observada (rate = total/min).
     Se total=0 → escolhe entre:
       (a) taxa OBSERVADA do match anterior em cache (m.perMinute.corners)
       (b) BASELINE 0.10/min (≈ 9 em 90′) quando NÃO há stats avançados
           (cenário Render: ENRICH_ENABLED=false ou /fixtures/statistics
           ainda não populou stats). Sem isso, computeCornersBet retornava
           null silenciosamente em todo match minimal-enriched.
     Se total=0 E há stats avançados (enrichment OK, mas jogo realmente sem
     corners ainda) → mantém comportamento antigo: nada a projetar com
     confiança.
     ============================================================ */
  let rate;
  let rateSource;
  if (total > 0) {
    rate = total / min;
    rateSource = 'observed';
  } else if (n(m.perMinute?.corners) > 0) {
    rate = n(m.perMinute.corners);
    rateSource = 'perMinute';
  } else if (!advanced) {
    rate = BASELINE_CORNERS_PER_MIN;
    rateSource = 'baseline';
  } else {
    // total=0 com stats avançados disponíveis → jogo sem nenhum corner
    // ainda (cenário raro com defesas dominantes). Não projetamos.
    if (PIPELINE_LOG) console.log(`[CORNER DEBUG] DROP zero-corners-with-stats | fixtureId=${m.fixtureId || m.id} | min=${min}`);
    return null;
  }

  // Adicionais esperados no tempo restante
  const expectedAdd = rate * remaining;
  const projected = total + expectedAdd;
  // Desvio: σ ~ sqrt(λ) (Poisson). Mais cedo = mais incerteza.
  const sigma = Math.max(0.9, Math.sqrt(Math.max(1, expectedAdd)));

  // Varre targets candidatos buscando P ≈ 50% (zona de valor)
  // P(over X.5) = aproximada por sigmoide(z), z = (projected - (X+0.5)) / σ
  let best = null;
  const minTarget = Math.max(Math.floor(total), 4);
  const maxTarget = Math.max(minTarget + 1, Math.ceil(projected) + 4);
  const probsByTarget = [];
  for (let target = minTarget; target <= maxTarget; target++) {
    const z = (projected - (target + 0.5)) / sigma;
    const prob = clamp(Math.round(50 + 50 * Math.tanh(z * 0.85)), 5, 95);
    probsByTarget.push({ target, prob });
    if (prob < 30 || prob > 70) continue;
    if (!best || Math.abs(prob - 50) < Math.abs(best.prob - 50)) {
      best = { target, prob };
    }
  }
  if (!best) {
    if (PIPELINE_LOG) {
      console.log(
        `[CORNER DEBUG] DROP no-target-in-band | fixtureId=${m.fixtureId || m.id} | ` +
        `total=${total} rate=${rate.toFixed(2)} (${rateSource}) projected=${projected.toFixed(1)} ` +
        `targets=${JSON.stringify(probsByTarget.slice(0, 6))}`
      );
    }
    return null;
  }

  // Ajustes finais de probabilidade (corroboração ofensiva)
  let probability = best.prob;
  if (dangBal >= 40) probability += 3;
  if (pressure >= 60) probability += 2;
  if (sotBal >= 3)   probability += 2;
  probability = clamp(probability, 25, 75);

  // Confiança = qualidade do dado
  // Sem stats avançados (rate=baseline), mantemos uma base mais conservadora
  // — sinais ainda saem mas com confiança menor, respeitando MIN_CONFIDENCE.
  let confidence = advanced ? 45 : 40;
  if (min >= 30)    confidence += 10;
  if (min >= 55)    confidence += 8;
  if (rate >= 0.18) confidence += 10;
  if (rate >= 0.28) confidence += 5;
  if (advanced) {
    if (dangBal >= 25)  confidence += 5;
    if (dangBal >= 50)  confidence += 5;
    if (sotBal >= 2)    confidence += 5;
    if (pressure >= 55) confidence += 5;
  } else {
    // Sem stats avançados, dá um boost moderado para placar empatado
    // (clássico cenário onde corners aceleram no fim) e minuto avançado.
    const tied = n(m.score?.home) === n(m.score?.away);
    if (tied)        confidence += 5;
    if (min >= 65)   confidence += 5;
  }
  confidence = clamp(confidence, 0, 95);

  return {
    market: 'corners',
    prediction: `Over ${best.target}.5 escanteios`,
    probability,
    confidence,
    oddEstimated: probToOdd(probability),
    justification:
      `${total} escanteios em ${min}′ (${rate.toFixed(2)}/min, fonte=${rateSource}) → projeção ${projected.toFixed(1)}. ` +
      `Ataques ${dangH}/${dangA}, pressão ${Math.round(pressure)}.`,
    extras: {
      target: best.target,
      currentCorners: total,
      projected: +projected.toFixed(1),
      ratePerMin: +rate.toFixed(2),
      rateSource,
      sigma: +sigma.toFixed(2),
      advanced,
    },
  };
}

/* ============================================================
   2) BTTS — Ambas Marcam (Sim/Não)
   Lógica: P(time marca no tempo restante) via Poisson com λ derivado
   de finalizações no alvo + ataques perigosos + escanteios.
   P(BTTS=Sim) = P(home marca) * P(away marca)   (independência).
   ============================================================ */
function computeBttsBet(m) {
  const min = Math.max(1, n(m.minute));
  const remaining = Math.max(0, 95 - min);
  const sh = n(m.score?.home);
  const sa = n(m.score?.away);

  // Já resolvido (ambos marcaram) → mercado pago, sem valor sinalizar.
  if (sh > 0 && sa > 0) return null;

  const sotH = n(m.stats?.shotsOnTarget?.home);
  const sotA = n(m.stats?.shotsOnTarget?.away);
  const dangH = n(m.stats?.dangerousAttacks?.home);
  const dangA = n(m.stats?.dangerousAttacks?.away);
  const cornH = n(m.stats?.corners?.home);
  const cornA = n(m.stats?.corners?.away);
  const sotRate = (sotH + sotA) / Math.max(1, min);
  const bttsLk = clamp(n(m.bttsLikelihood), 0, 100);
  const advanced = hasAdvancedStats(m);

  /**
   * xG simples baseado nos indicadores acumulados, projetado linearmente
   * para o tempo restante. Coeficientes calibrados:
   *   SoT × 0.22  (conversão típica ~22% para chutes no alvo)
   *   Dang × 0.005
   *   Corner × 0.04
   */
  function lambdaRestante(sot, dang, corn) {
    const xgAcum = sot * 0.22 + dang * 0.005 + corn * 0.04;
    const xgPorMin = xgAcum / Math.max(1, min);
    return Math.max(0, xgPorMin * remaining);
  }

  // FALLBACK: sem stats avançados, usa baseline xG (placar+minuto+posse)
  let lamH, lamA;
  if (advanced) {
    lamH = sh > 0 ? 99 : lambdaRestante(sotH, dangH, cornH);
    lamA = sa > 0 ? 99 : lambdaRestante(sotA, dangA, cornA);
  } else {
    const base = baselineXG(m);
    lamH = sh > 0 ? 99 : base.lamHRest;
    lamA = sa > 0 ? 99 : base.lamARest;
  }

  // P(time marca pelo menos 1) = 1 - e^(-λ). Se já marcou, P=1.
  const pH = sh > 0 ? 100 : Math.round((1 - Math.exp(-lamH)) * 100);
  const pA = sa > 0 ? 100 : Math.round((1 - Math.exp(-lamA)) * 100);

  // P(BTTS Sim) com independência
  const rawYes = Math.round((pH / 100) * (pA / 100) * 100);
  // Mistura com bttsLikelihood (já considera placar + finalizações). Quando não há
  // stats avançados, bttsLk é só ruído de placar inicial — peso menor.
  const lkWeight = advanced ? 0.30 : 0.20;
  const adjYes = Math.round(rawYes * (1 - lkWeight) + bttsLk * lkWeight);

  let direction, probability;
  if (adjYes >= 50) { direction = 'sim'; probability = adjYes; }
  else              { direction = 'nao'; probability = 100 - adjYes; }

  // Confiança
  let confidence = 45;
  if (min >= 35)             confidence += 8;
  if (min >= 55)             confidence += 8;
  if (min >= 70)             confidence += 6;
  if (advanced) {
    if (sotRate >= 0.06)         confidence += 8;
    if (sotRate >= 0.10)         confidence += 4;
    if (Math.min(sotH, sotA) >= 2)    confidence += 8;
    if (Math.min(dangH, dangA) >= 20) confidence += 5;
  } else {
    // Sem stats: confiança extra vem do tempo investido no jogo + placar
    confidence += 4;                  // base extra (substituí parte do bônus de stats)
    if (min >= 30)            confidence += 4;
    if (min >= 60)            confidence += 4;
    if (sh + sa >= 1)         confidence += 6; // jogo com gol = mais sinal
  }
  if (sh + sa >= 1)          confidence += 4; // jogo aberto
  confidence = clamp(confidence, 0, 95);

  return {
    market: 'btts',
    prediction: direction === 'sim' ? 'Ambas marcam: Sim' : 'Ambas marcam: Não',
    probability,
    confidence,
    oddEstimated: probToOdd(probability),
    justification: advanced
      ? (`${sh}×${sa} em ${min}′. SoT H:${sotH}/A:${sotA}, ataques perigosos ${dangH}/${dangA}. ` +
         `P(home marca)=${pH}%, P(away marca)=${pA}% → BTTS Sim ${adjYes}%.`)
      : (`${sh}×${sa} em ${min}′ (sem stats avançados — modelo baseline). ` +
         `P(home marca)=${pH}%, P(away marca)=${pA}% → BTTS Sim ${adjYes}%.`),
    extras: {
      direction,
      pHomeScores: pH,
      pAwayScores: pA,
      pYes: adjYes,
      lambdaHomeRemaining: +lamH.toFixed(2),
      lambdaAwayRemaining: +lamA.toFixed(2),
      baseline: !advanced,
    },
  };
}

/* ============================================================
   3) WIN — 1X2 (Home / Draw / Away)
   Lógica: modelo Poisson 2-D sobre gols restantes:
     - λ_home = xG-rate × remaining × (1 + posseEdge)
     - λ_away = xG-rate × remaining × (1 - posseEdge)
   Somamos massa de probabilidade nos 49 placares finais (0..6 × 0..6)
   e classificamos em H/D/A. Aproxima razoavelmente o mercado 1X2.
   Vantagem de casa entra como (a) prior score-based e (b) edge de posse.
   ============================================================ */
function computeWinBet(m) {
  const min = Math.max(1, n(m.minute));
  const remaining = Math.max(0, 95 - min);
  const sh = n(m.score?.home);
  const sa = n(m.score?.away);
  const lead = sh - sa;

  const sotH = n(m.stats?.shotsOnTarget?.home);
  const sotA = n(m.stats?.shotsOnTarget?.away);
  const dangH = n(m.stats?.dangerousAttacks?.home);
  const dangA = n(m.stats?.dangerousAttacks?.away);
  const cornH = n(m.stats?.corners?.home);
  const cornA = n(m.stats?.corners?.away);
  const possH = n(m.stats?.possession?.home) || 50;
  const possA = 100 - possH;
  const advanced = hasAdvancedStats(m);

  // xG acumulado por time e taxa por minuto (ou baseline quando sem stats)
  let lamH, lamA;
  if (advanced) {
    const xgH = sotH * 0.22 + dangH * 0.005 + cornH * 0.04;
    const xgA = sotA * 0.22 + dangA * 0.005 + cornA * 0.04;
    const xgRateH = xgH / Math.max(1, min);
    const xgRateA = xgA / Math.max(1, min);
    const possEdge = (possH - possA) / 100;
    lamH = Math.max(0, xgRateH * remaining * (1 + possEdge * 0.20));
    lamA = Math.max(0, xgRateA * remaining * (1 - possEdge * 0.20));
  } else {
    const base = baselineXG(m);
    lamH = base.lamHRest;
    lamA = base.lamARest;
  }

  // Probabilidade Poisson conjunta para gols ADICIONAIS
  let probH = 0, probD = 0, probA = 0;
  const MAX_GOALS = 6; // truncamento (cauda de Poisson para λ <= 3 é ínfima após 6)
  for (let gh = 0; gh <= MAX_GOALS; gh++) {
    const ph = poisson(lamH, gh);
    if (ph < 1e-6) continue;
    for (let ga = 0; ga <= MAX_GOALS; ga++) {
      const pa = poisson(lamA, ga);
      const p = ph * pa;
      const finalH = sh + gh;
      const finalA = sa + ga;
      if      (finalH > finalA) probH += p;
      else if (finalH < finalA) probA += p;
      else                      probD += p;
    }
  }
  // Normaliza (Poisson truncada perde um epsilon de massa)
  const sumP = probH + probD + probA;
  if (sumP > 0) { probH /= sumP; probD /= sumP; probA /= sumP; }

  // Prior score-based: blend mais peso quanto MENOS tempo resta
  const lockFactor = clamp(1 - remaining / 95, 0, 1);
  let priorH, priorD, priorA;
  if      (lead >= 2)  { priorH = 0.92; priorD = 0.07; priorA = 0.01; }
  else if (lead === 1) { priorH = 0.58; priorD = 0.28; priorA = 0.14; }
  else if (lead === 0) { priorH = 0.40; priorD = 0.28; priorA = 0.32; } // vantagem de casa
  else if (lead === -1){ priorH = 0.14; priorD = 0.28; priorA = 0.58; }
  else                 { priorH = 0.01; priorD = 0.07; priorA = 0.92; }

  // Mix: 50% Poisson + 50% × lockFactor para o prior
  const blendW = 0.5 * lockFactor;
  let pH = probH * (1 - blendW) + priorH * blendW;
  let pD = probD * (1 - blendW) + priorD * blendW;
  let pA = probA * (1 - blendW) + priorA * blendW;
  const sum2 = pH + pD + pA;
  if (sum2 > 0) { pH /= sum2; pD /= sum2; pA /= sum2; }

  const probs = {
    home: Math.round(pH * 100),
    draw: Math.round(pD * 100),
    away: Math.round(pA * 100),
  };
  // Ajusta arredondamento para somar 100
  const diff = 100 - (probs.home + probs.draw + probs.away);
  if (diff !== 0) {
    // soma no maior (estabilidade visual)
    const key = probs.home >= probs.draw && probs.home >= probs.away ? 'home'
              : probs.away >= probs.draw                              ? 'away' : 'draw';
    probs[key] += diff;
  }

  // Predição = maior probabilidade
  let prediction, probability, side;
  if (probs.home >= probs.draw && probs.home >= probs.away) {
    prediction = `Vitória ${m.home}`; probability = probs.home; side = 'home';
  } else if (probs.away >= probs.home && probs.away >= probs.draw) {
    prediction = `Vitória ${m.away}`; probability = probs.away; side = 'away';
  } else {
    prediction = 'Empate';            probability = probs.draw; side = 'draw';
  }

  // Confiança
  const edgeH = sotH * 3 + dangH * 0.1 + cornH * 1.5;
  const edgeA = sotA * 3 + dangA * 0.1 + cornA * 1.5;
  const edgeDiff = Math.abs(edgeH - edgeA);
  let confidence = 45;
  if (min >= 25)        confidence += 8;
  if (min >= 45)        confidence += 8;
  if (min >= 65)        confidence += 8;
  if (min >= 80)        confidence += 5;
  if (advanced) {
    if (edgeDiff >= 15)   confidence += 5;
    if (edgeDiff >= 30)   confidence += 5;
  } else {
    // Sem stats avançados: corroboração só pode vir do placar+tempo
    if (Math.abs(lead) >= 1 && min >= 60) confidence += 5;
  }
  if (Math.abs(lead) >= 1) confidence += 5;
  if (Math.abs(lead) >= 2) confidence += 5;
  confidence = clamp(confidence, 0, 95);

  return {
    market: 'win',
    prediction,
    probability,
    confidence,
    oddEstimated: probToOdd(probability),
    justification:
      `${sh}×${sa} em ${min}′. xG restante H:${lamH.toFixed(2)}/A:${lamA.toFixed(2)}. ` +
      `Posse ${possH}%/${possA}%. P(H/D/A)=${probs.home}/${probs.draw}/${probs.away}.`,
    extras: {
      side,
      probabilities: probs,
      expectedGoalsRemaining: { home: +lamH.toFixed(2), away: +lamA.toFixed(2) },
      edge: { home: +edgeH.toFixed(1), away: +edgeA.toFixed(1) },
    },
  };
}

/* ============================================================
   CORE — processMatch + emit
   ============================================================ */
function safe(fn) {
  try { return fn(); } catch (e) {
    log.warn('signal compute fail', { err: e.message });
    return null;
  }
}

/**
 * Determina o nível de risco a partir da confiança + odd.
 *   - low  (verde): conf >= 80
 *   - med  (amarelo): 70..79
 *   - high (vermelho): < 70 (não deveria chegar aqui pelo filtro, mas seguro)
 */
function riskFromMetrics(confidence) {
  if (confidence >= 80) return { level: 'LOW',  emoji: '🟢', label: 'BAIXO' };
  if (confidence >= 70) return { level: 'MED',  emoji: '🟡', label: 'MÉDIO' };
  return { level: 'HIGH', emoji: '🔴', label: 'ALTO' };
}

/* ============================================================
   SCORING — "Melhor Aposta do Momento"
   --------------------------------------------------------------
   Score composto (0..100) usado para destacar o sinal de maior valor:

     score = 0.50*confidence
           + 0.25*valueScore
           + 0.15*momentumScore
           + 0.10*riskScore

   - confidence:   já vem do modelo (qualidade do sinal)
   - valueScore:   value betting → EV (expected value).
                   EV positivo → odd estimada está acima do "justo".
                   Como filtramos odd entre 1.80–2.20, EV ≈ (odd*prob/100) - 1.
                   Normalizado para 0..100.
   - momentumScore: jogos no meio (30–70min) costumam ter melhor previsibilidade
                    que partidas no início ou recta-final.
   - riskScore:    LOW=100 / MED=70 / HIGH=30 (inverso do risco).
   ============================================================ */
function valueScore(probability, odd) {
  const ev = (odd * (probability / 100)) - 1; // expected value sobre stake=1
  // ev típico: -0.10 .. +0.20 nesse range de odd. Normaliza para 0..100.
  const norm = ((ev + 0.10) / 0.30) * 100;
  return clamp(norm, 0, 100);
}

function momentumScore(minute) {
  const min = n(minute);
  if (min >= 35 && min <= 70) return 100;
  if (min >= 25 && min <= 80) return 80;
  if (min >= 20 && min <= 85) return 60;
  return 40;
}

function riskScore(level) {
  const l = String(level || '').toUpperCase();
  if (l === 'LOW' || l === 'BAIXO') return 100;
  if (l === 'MED' || l === 'MEDIO' || l === 'MÉDIO') return 70;
  return 30;
}

function computeBetScore(signal) {
  const c = signal.confidence || 0;
  const v = valueScore(signal.probability || 0, signal.oddEstimated || 0);
  const m = momentumScore(signal.match?.minute);
  const r = riskScore(signal.risk?.level);
  const score = 0.50 * c + 0.25 * v + 0.15 * m + 0.10 * r;
  return {
    score: Math.round(score),
    breakdown: { confidence: c, value: Math.round(v), momentum: m, risk: r },
  };
}

/* ============================================================
   JUSTIFICATIVA PREMIUM — explicação rica e contextual
   --------------------------------------------------------------
   Pega os dados estatísticos no extras + match e monta uma narrativa
   curta tipo "consultor". Tier FREE recebe a justification crua;
   tier PREMIUM recebe a versão `premiumInsight` com análise contextual.
   ============================================================ */
function premiumInsight(c, m, scoreInfo) {
  const stats = m.stats || {};
  const min = n(m.minute);
  const home = m.home || 'Casa';
  const away = m.away || 'Fora';
  const dangH = n(stats.dangerousAttacks?.home);
  const dangA = n(stats.dangerousAttacks?.away);
  const cornH = n(stats.corners?.home);
  const cornA = n(stats.corners?.away);
  const sotH  = n(stats.shotsOnTarget?.home);
  const sotA  = n(stats.shotsOnTarget?.away);
  const possH = n(stats.possession?.home);
  const possA = n(stats.possession?.away);

  const parts = [];

  if (c.market === 'corners') {
    const totalCorners = cornH + cornA;
    const totalDang = dangH + dangA;
    parts.push(`📊 ${totalCorners} escanteios em ${min}′ (ritmo ${(totalCorners / Math.max(min, 1) * 90).toFixed(1)}/90′)`);
    if (totalDang >= 60) parts.push(`⚡ Pressão ofensiva alta: ${totalDang} ataques perigosos`);
    if (sotH + sotA >= 8) parts.push(`🎯 ${sotH + sotA} chutes no alvo — ataques produtivos`);
    const sidePush = cornH > cornA + 2 ? home : cornA > cornH + 2 ? away : null;
    if (sidePush) parts.push(`📈 ${sidePush} dominando a pressão lateral`);
  } else if (c.market === 'btts') {
    const side = c.extras?.side;
    if (side === 'yes') {
      parts.push(`⚽ Ambos os ataques produtivos: H ${sotH}/A ${sotA} chutes no alvo`);
      if (dangH >= 30 && dangA >= 30) parts.push(`🔥 Pressão bilateral (H${dangH}/A${dangA} ataques perigosos)`);
      parts.push(`📊 Defesas vulneráveis no momento — alta probabilidade de gols dos dois lados`);
    } else {
      parts.push(`🛡️ Defesas sólidas: ${sotH + sotA} chutes no alvo só`);
      if (min >= 60) parts.push(`⏱️ ${90 - min}′ restantes — janela curta para virar BTTS`);
    }
  } else if (c.market === 'win') {
    const side = c.extras?.side;
    const probs = c.extras?.probabilities;
    if (side === 'home') {
      parts.push(`🏠 ${home} controlando: ${possH}% posse, ${sotH} chutes no alvo (vs ${sotA})`);
    } else if (side === 'away') {
      parts.push(`✈️ ${away} dominante fora: ${possA}% posse, ${sotA} chutes no alvo (vs ${sotH})`);
    } else {
      parts.push(`⚖️ Equilíbrio: posse ${possH}/${possA}%, chutes ${sotH}/${sotA} — empate provável`);
    }
    if (probs) parts.push(`📈 Modelo: H ${probs.home}% / E ${probs.draw}% / F ${probs.away}%`);
    if (min >= 75) parts.push(`⏱️ Jogo "travado" em ${min}′ — placar tende a se manter`);
  }

  if (scoreInfo) {
    parts.push(`💎 Score IA ${scoreInfo.score}/100 — confiança ${scoreInfo.breakdown.confidence}, valor ${scoreInfo.breakdown.value}, momento ${scoreInfo.breakdown.momentum}`);
  }

  return parts.join(' • ');
}

/* ============================================================
   TIER — classifica o sinal entre FREE e PREMIUM
   ============================================================ */
function tierFor(confidence) {
  return confidence >= PREMIUM_MIN_CONFIDENCE ? 'premium' : 'free';
}

function buildSignal(m, c) {
  const header = matchHeader(m);
  const risk = riskFromMetrics(c.confidence);
  const tier = tierFor(c.confidence);
  const baseSignal = {
    type: 'bet:opportunity',
    market: c.market,
    matchId: m.fixtureId,
    match: header,
    prediction: c.prediction,
    probability: c.probability,
    confidence: c.confidence,
    oddEstimated: c.oddEstimated,
    justification: c.justification,
    extras: c.extras || null,
    // Tier + score (novidades para diferenciar FREE vs PREMIUM)
    tier,
    // Campos de compatibilidade com clientes legacy
    home: header.home,
    away: header.away,
    league: header.league,
    minute: header.minute,
    score: header.score,
    suggestion: c.prediction,
    reasoning: c.justification,
    risk,
    classification: { label: c.market.toUpperCase(), emoji: c.market === 'corners' ? '🚩' : c.market === 'btts' ? '🎯' : '🏆' },
    createdAt: new Date().toISOString(),
  };
  // Score composto + insight premium
  const scoreInfo = computeBetScore(baseSignal);
  baseSignal.betScore = scoreInfo.score;
  baseSignal.scoreBreakdown = scoreInfo.breakdown;
  baseSignal.premiumInsight = premiumInsight(c, m, scoreInfo);
  return baseSignal;
}

// Melhor sinal "do momento" — atualizado a cada emit, expira em BEST_TTL_MS
let bestSignal = null;

function bestStillValid() {
  if (!bestSignal) return false;
  const age = Date.now() - new Date(bestSignal.createdAt).getTime();
  return age < BEST_TTL_MS;
}

function refreshBestSignal(signal) {
  const candidates = [signal];
  if (bestStillValid()) candidates.push(bestSignal);
  candidates.sort((a, b) => (b.betScore || 0) - (a.betScore || 0));
  const newBest = candidates[0];
  const changed = !bestSignal
    || bestSignal.matchId !== newBest.matchId
    || bestSignal.market !== newBest.market
    || (bestSignal.betScore || 0) !== (newBest.betScore || 0);
  bestSignal = newBest;
  if (changed) {
    log.info('best signal updated', {
      market: newBest.market,
      score: newBest.betScore,
      conf: newBest.confidence,
      match: `${newBest.match.home} x ${newBest.match.away}`,
    });
    events.emit('signal:best', getBestSignal());
  }
}

function getBestSignal() {
  if (!bestStillValid()) return null;
  // Best signal só é exposto se for tier premium (qualidade >= PREMIUM_MIN_CONFIDENCE)
  if (bestSignal.tier !== 'premium') return null;
  return bestSignal;
}

function emit(signal) {
  recent.unshift(signal);
  if (recent.length > RECENT_MAX) recent.length = RECENT_MAX;
  g_recent.set(recent.length);
  m_emitted.inc(1, { market: signal.market, tier: signal.tier });
  log.info('bet signal emitted', {
    market: signal.market,
    pred: signal.prediction,
    prob: signal.probability,
    conf: signal.confidence,
    odd: signal.oddEstimated,
    score: signal.betScore,
    tier: signal.tier,
    match: `${signal.match.home} x ${signal.match.away}`,
    minute: signal.match.minute,
  });
  // Atualiza melhor aposta do momento (apenas premium concorre)
  if (signal.tier === 'premium') refreshBestSignal(signal);
  const socketPayload = {
    type: signal.type,
    market: signal.market,
    prediction: signal.prediction,
    confidence: signal.confidence,
    oddEstimated: signal.oddEstimated,
    matchId: signal.matchId,
    home: signal.match?.home,
    away: signal.match?.away,
    minute: signal.match?.minute,
  };
  console.log('[LIVE SOCKET EMIT] payload', socketPayload);
  // Emite no event bus — footballRealtime broadcasta para dashboard (signal:new).
  events.emit('signal:new', signal);
}

/**
 * Resumo curto de match usado nos logs/drops para diagnóstico.
 * Não inclui campos pesados (stats completos, eventos, etc).
 */
function matchSummary(m) {
  return {
    matchId: m?.fixtureId,
    label: `${m?.home || '?'} x ${m?.away || '?'}`,
    league: m?.league?.name || m?.league,
    minute: m?.minute,
    status: m?.status,
    score: m?.score,
    enriched: !!m?.enriched,
    hasStats: !!m?.stats,
    dataQuality: m?.dataQuality || null,
  };
}

function dropAndLog(stage, m, extra = {}) {
  recordFunnel(stage);
  m_skipped.inc(1, { reason: stage, ...(extra.market ? { market: extra.market } : {}) });
  recordDrop({ stage, match: matchSummary(m), ...extra });
  if (DEBUG_MODE) {
    log.info('bet signal DROP', { stage, match: matchSummary(m), ...extra });
  }
  if (PIPELINE_LOG) {
    const label = matchSummary(m);
    console.log(`[LIVE SIGNAL DROP] ${stage} | ${label.label} | ${extra.reason || extra.prediction || JSON.stringify(extra).slice(0, 120)}`);
  }
}

/**
 * Fallback LOCAL (zero API): placar/minuto → stats mínimos para o engine
 * analisar. Não altera thresholds de aposta — só destrava ENRICH_ENABLED=false.
 */
function ensureMinimalMatchStats(m) {
  if (TEST_MODE || !m) return;
  if (m.enriched && m.stats && !m.enrichedPartial) return;
  if (m.enriched && m.stats) return;
  try {
    const { applyMinimalEnrichment } = require('./fixtureNormalizer');
    applyMinimalEnrichment(m);
    const id = String(m.fixtureId || m.id || '');
    if (id) {
      try {
        const poller = getPoller();
        poller.cache?.set?.(id, m);
      } catch (_) { /* poller opcional */ }
    }
  } catch (_) { /* defensivo */ }
}

function processMatch(m) {
  recordFunnel('input');

  if (!m) { dropAndLog('no-match', m); return; }

  const matchHead = `[LIVE PIPELINE] match id=${m.fixtureId || m.id} ${m.home} x ${m.away} ${n(m.score?.home)}-${n(m.score?.away)} (${n(m.minute)}′)`;
  const advanced = hasAdvancedStats(m);
  if (PIPELINE_LOG) {
    console.log(matchHead, {
      enriched: !!m.enriched,
      hasStats: !!m.stats,
      advancedStats: advanced,
      possession: m.stats?.possession?.home ?? null,
      shotsOnTarget: { home: n(m.stats?.shotsOnTarget?.home), away: n(m.stats?.shotsOnTarget?.away) },
      dangerousAttacks: { home: n(m.stats?.dangerousAttacks?.home), away: n(m.stats?.dangerousAttacks?.away) },
      corners: { home: n(m.stats?.corners?.home), away: n(m.stats?.corners?.away) },
    });
  }

  // === Gate de dados ============================================
  // Em TEST_MODE processamos qualquer fixture (mesmo sem enriquecimento)
  // para o usuário ver SE alguma coisa estaria sendo gerada.
  if (!TEST_MODE) {
    ensureMinimalMatchStats(m);
    if (!m.enriched) { dropAndLog('not-enriched', m); return; }
    if (!m.stats)    { dropAndLog('no-stats', m); return; }
  } else {
    if (!m.enriched) recordFunnel('not-enriched');
    if (!m.stats)    recordFunnel('no-stats');
  }

  const min = n(m.minute);
  if (min < MIN_MINUTE || min > MAX_MINUTE) {
    dropAndLog('minute-out-of-range', m, { minute: min, range: [MIN_MINUTE, MAX_MINUTE] });
    return;
  }
  recordFunnel('computed');
  m_processed.inc();

  const rawCandidates = [
    { market: 'corners', fn: () => computeCornersBet(m) },
    { market: 'btts',    fn: () => computeBttsBet(m)    },
    { market: 'win',     fn: () => computeWinBet(m)     },
  ];

  for (const { market, fn } of rawCandidates) {
    const c = safe(fn);
    if (!c) {
      recordFunnel('compute-null');
      recordDrop({ stage: 'compute-null', market, match: matchSummary(m), reason: 'compute returned null (sem dados ou mercado resolvido)' });
      if (PIPELINE_LOG) console.log(`[LIVE PIPELINE] DROP compute-null | ${m.home} x ${m.away} | market=${market} | motivo=sem dados ou mercado resolvido`);
      continue;
    }

    if (PIPELINE_LOG) {
      console.log(`[LIVE PIPELINE] candidate ${market} | conf=${c.confidence} | prob=${c.probability} | odd=${c.oddEstimated} | ${c.prediction}`);
    }

    if (c.confidence < MIN_CONFIDENCE) {
      if (PIPELINE_LOG) console.log(`[LIVE PIPELINE] DROP low-confidence | ${m.home} x ${m.away} | market=${c.market} | conf=${c.confidence} < min=${MIN_CONFIDENCE} | pred=${c.prediction}`);
      dropAndLog('low-confidence', m, {
        market: c.market,
        confidence: c.confidence,
        minRequired: MIN_CONFIDENCE,
        probability: c.probability,
        prediction: c.prediction,
      });
      continue;
    }
    if (c.oddEstimated < MIN_ODD || c.oddEstimated > MAX_ODD) {
      if (PIPELINE_LOG) console.log(`[LIVE PIPELINE] DROP odd-out-of-range | ${m.home} x ${m.away} | market=${c.market} | odd=${c.oddEstimated} fora=[${MIN_ODD},${MAX_ODD}] | conf=${c.confidence} | pred=${c.prediction}`);
      dropAndLog('odd-out-of-range', m, {
        market: c.market,
        oddEstimated: c.oddEstimated,
        oddRange: [MIN_ODD, MAX_ODD],
        confidence: c.confidence,
        probability: c.probability,
        prediction: c.prediction,
      });
      continue;
    }
    const key = `${m.fixtureId}:${c.market}`;
    if (!canFire(key)) {
      if (PIPELINE_LOG) console.log(`[LIVE PIPELINE] DROP cooldown | ${m.home} x ${m.away} | market=${c.market} | cooldownMs=${COOLDOWN_MS} | conf=${c.confidence} | pred=${c.prediction}`);
      dropAndLog('cooldown', m, {
        market: c.market,
        cooldownMs: COOLDOWN_MS,
        confidence: c.confidence,
        prediction: c.prediction,
      });
      continue;
    }
    recordFunnel('emitted');
    if (tickByMarket && tickByMarket[c.market] !== undefined) {
      tickByMarket[c.market]++;
    }
    if (PIPELINE_LOG) console.log(`[LIVE PIPELINE] EMIT ${c.market} | ${m.home} x ${m.away} | conf=${c.confidence} | odd=${c.oddEstimated} | ${c.prediction}`);
    emit(buildSignal(m, c));
  }
}

/* ============================================================
   LIFECYCLE
   ============================================================ */
let timer = null;
let started = false;

let lastTickAt = null;
let lastTickSummary = null;
let tickByMarket = { corners: 0, btts: 0, win: 0 };
let cornersStats = { withTotal: 0, totalZeroNoAdv: 0, totalZeroWithAdv: 0 };

function tick() {
  if (!ENABLED) {
    console.log('[LIVE DEBUG] pipeline skipped — BET_SIGNAL_ENABLED=false');
    return;
  }
  const t0 = Date.now();
  resetTickFunnel();
  console.log('[LIVE DEBUG] pipeline start');
  try {
    const poller = getPoller();
    const matches = poller.getMatches();
    const enrichedCount = matches.filter((m) => m?.enriched && m?.stats).length;
    console.log(`[ENGINE INPUT] matchesReceived=${matches.length} enriched=${enrichedCount} pollerCache=${poller.cache?.size ?? '?'}`);
    console.log('[LIVE DEBUG] input matches count', matches.length);
    console.log('[LIVE DEBUG] enriched matches count', enrichedCount);
    if (PIPELINE_LOG) {
      console.log('[LIVE DEBUG] thresholds', {
        minConf: MIN_CONFIDENCE,
        odd: [MIN_ODD, MAX_ODD],
        minute: [MIN_MINUTE, MAX_MINUTE],
      });
    }
    // Contadores por mercado dentro do tick (não persistem entre ticks).
    tickByMarket = { corners: 0, btts: 0, win: 0 };
    cornersStats = { withTotal: 0, totalZeroNoAdv: 0, totalZeroWithAdv: 0 };
    for (const m of matches) {
      const c = n(m.stats?.corners?.total);
      const adv = hasAdvancedStats(m);
      if (c > 0) cornersStats.withTotal++;
      else if (!adv) cornersStats.totalZeroNoAdv++;
      else cornersStats.totalZeroWithAdv++;
      processMatch(m);
    }
  } catch (e) {
    log.error('tick error', { err: e.message });
    console.log('[LIVE DEBUG] pipeline error', e.message);
  } finally {
    const dur = Date.now() - t0;
    m_lat.observe(dur);
    lastTickAt = Date.now();
    lastTickSummary = { ...tickFunnel, durationMs: dur };
    const notEnriched = tickFunnel['not-enriched'] || 0;
    const noStats = tickFunnel['no-stats'] || 0;
    const lowConf = tickFunnel['low-confidence'] || 0;
    const emitted = tickFunnel.emitted || 0;
    console.log('[LIVE DEBUG] dropped not-enriched count', notEnriched);
    console.log('[LIVE DEBUG] dropped no-stats count', noStats);
    console.log('[LIVE DEBUG] dropped low-confidence count', lowConf);
    console.log('[LIVE DEBUG] emitted signals count', emitted);
    console.log(`[ENGINE SNAPSHOT] signalsInMemory=${recent.length} emittedThisTick=${emitted} lastTickAt=${new Date(lastTickAt).toISOString()}`);
    console.log(
      `[CORNER REPORT] tick: matchesIn=${tickFunnel.input || 0} ` +
      `withCornerData=${cornersStats.withTotal} totalZeroNoAdv=${cornersStats.totalZeroNoAdv} ` +
      `totalZeroWithAdv=${cornersStats.totalZeroWithAdv} → ` +
      `emitted: corners=${tickByMarket.corners} btts=${tickByMarket.btts} win=${tickByMarket.win}`
    );
    console.log('[LIVE DEBUG] pipeline end', {
      durationMs: dur,
      minuteOutOfRange: tickFunnel['minute-out-of-range'] || 0,
      oddOutOfRange: tickFunnel['odd-out-of-range'] || 0,
      cooldown: tickFunnel.cooldown || 0,
      computeNull: tickFunnel['compute-null'] || 0,
      recentBuffer: recent.length,
      socketEvent: 'signal:new',
      payloadType: 'bet:opportunity',
    });
    if (DEBUG_MODE || TEST_MODE) {
      log.info('bet signal tick summary', {
        mode: TEST_MODE ? 'TEST' : (DEBUG_MODE ? 'DEBUG' : 'PROD'),
        durationMs: dur,
        funnel: tickFunnel,
        thresholds: {
          minConf: MIN_CONFIDENCE,
          oddRange: [MIN_ODD, MAX_ODD],
          minuteRange: [MIN_MINUTE, MAX_MINUTE],
          cooldownMs: COOLDOWN_MS,
        },
      });
    }
  }
}

function start() {
  if (!ENABLED) {
    log.warn('betSignalEngine desabilitado (BET_SIGNAL_ENABLED=false)');
    console.log('[LIVE DEBUG] betSignalEngine NOT started — BET_SIGNAL_ENABLED=false');
    return;
  }
  if (started) return;
  started = true;
  console.log('[LIVE DEBUG] betSignalEngine started', { tickMs: TICK_MS, minConfidence: MIN_CONFIDENCE });
  log.info('betSignalEngine started', {
    mode: TEST_MODE ? 'TEST' : (DEBUG_MODE ? 'DEBUG' : 'PROD'),
    tickMs: TICK_MS,
    minConfidence: MIN_CONFIDENCE,
    oddRange: [MIN_ODD, MAX_ODD],
    minuteRange: [MIN_MINUTE, MAX_MINUTE],
    cooldownMs: COOLDOWN_MS,
  });
  if (TEST_MODE) {
    log.warn('⚠️  BET_SIGNAL_TEST_MODE ATIVO — thresholds afrouxados (não use em produção).');
  }
  if (DEBUG_MODE) {
    log.warn('🔍 BET_SIGNAL_DEBUG ATIVO — logs verbosos por decisão. Pode poluir o stdout.');
  }
  setTimeout(tick, 5_000);
  timer = setInterval(tick, TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}

function snapshot() {
  return {
    enabled: ENABLED,
    started,
    mode: TEST_MODE ? 'TEST' : (DEBUG_MODE ? 'DEBUG' : 'PROD'),
    debugMode: DEBUG_MODE,
    testMode: TEST_MODE,
    tickMs: TICK_MS,
    minConfidence: MIN_CONFIDENCE,
    freeMinConfidence: FREE_MIN_CONFIDENCE,
    premiumMinConfidence: PREMIUM_MIN_CONFIDENCE,
    oddRange: { min: MIN_ODD, max: MAX_ODD },
    minuteRange: { min: MIN_MINUTE, max: MAX_MINUTE },
    cooldownMs: COOLDOWN_MS,
    freeDelayMs: FREE_DELAY_MS,
    bestTtlMs: BEST_TTL_MS,
    activeCooldowns: cooldowns.size,
    recent: recent.length,
    bestSignalActive: bestStillValid(),
    lastTickAt,
    lastTickSummary,
    lastTickByMarket: { ...tickByMarket },
    lastCornersStats: { ...cornersStats },
    funnelTotals: { ...funnelTotals },
  };
}

/**
 * Relatório de diagnóstico completo: snapshot + amostra das últimas N
 * decisões de descarte (com motivo + payload curto), para o usuário
 * descobrir POR QUE nenhum sinal está sendo gerado.
 */
function debugReport({ dropLimit = 30 } = {}) {
  const totalIn = funnelTotals.input || 0;
  const breakdown = {};
  for (const k of FUNNEL_KEYS) {
    const v = funnelTotals[k] || 0;
    breakdown[k] = { count: v, pct: totalIn ? +(v * 100 / totalIn).toFixed(1) : 0 };
  }
  // Top motivos de drop nos últimos N descartes (qualitativo)
  const reasonHistogram = {};
  for (const d of recentDrops) {
    reasonHistogram[d.stage] = (reasonHistogram[d.stage] || 0) + 1;
  }
  return {
    snapshot: snapshot(),
    funnelTotals,
    funnelBreakdown: breakdown,
    lastTickSummary,
    lastTickAt,
    recentDrops: recentDrops.slice(0, dropLimit),
    recentDropsReasonHistogram: reasonHistogram,
    recentEmitted: recent.slice(0, 10).map((s) => ({
      market: s.market,
      prediction: s.prediction,
      confidence: s.confidence,
      odd: s.oddEstimated,
      score: s.betScore,
      match: s.match,
      createdAt: s.createdAt,
    })),
    hints: buildHints(breakdown),
  };
}

/**
 * Gera dicas legíveis identificando o gargalo. Usa heurísticas simples
 * sobre o funil para apontar onde a maioria dos matches está sumindo.
 */
function buildHints(breakdown) {
  const hints = [];
  const inP = breakdown.input?.count || 0;
  if (inP === 0) {
    hints.push('Nenhuma fixture chegou ao engine — verifique o poller (FOOTBALL_POLL_INTERVAL_MS, provider, quota).');
    return hints;
  }
  const not = breakdown['not-enriched']?.count || 0;
  const ns  = breakdown['no-stats']?.count || 0;
  if ((not + ns) / inP > 0.7) {
    hints.push(`> ${Math.round((not + ns) * 100 / inP)}% dos jogos não estão enriquecidos. Verifique a quota da API-Football ou ative ENRICH_ENABLED.`);
  }
  if ((breakdown['minute-out-of-range']?.count || 0) / Math.max(inP, 1) > 0.4) {
    hints.push('> 40% dos jogos caem fora da janela 20-85 min. Considere ajustar BET_SIGNAL_MIN_MINUTE/MAX_MINUTE.');
  }
  if ((breakdown['low-confidence']?.count || 0) > (breakdown.emitted?.count || 0) * 3) {
    hints.push(`Muitos candidatos rejeitados por confidence < ${MIN_CONFIDENCE}. Considere baixar BET_SIGNAL_MIN_CONFIDENCE temporariamente.`);
  }
  if ((breakdown['odd-out-of-range']?.count || 0) > (breakdown.emitted?.count || 0) * 3) {
    hints.push(`Faixa de odd [${MIN_ODD}, ${MAX_ODD}] é restritiva. Sinais com prob > 55% (odd < 1.80) ou < 45% (odd > 2.20) estão sendo descartados.`);
  }
  if ((breakdown.cooldown?.count || 0) > inP * 0.3) {
    hints.push('Muitos sinais bloqueados por cooldown (10min). Em ambiente de teste, BET_SIGNAL_TEST_MODE=true desliga o cooldown.');
  }
  if (!hints.length) {
    hints.push('Pipeline saudável — nenhum gargalo óbvio. Se sinais ainda não aparecem, rode `node scripts/diagnose-signals.js` para detalhes.');
  }
  return hints;
}

function listRecent({ limit = 50, market = null, minConfidence = 0, sinceMs = 0 } = {}) {
  let out = recent;
  if (market) out = out.filter((s) => s.market === market);
  if (minConfidence) out = out.filter((s) => s.confidence >= minConfidence);
  if (sinceMs) {
    const cutoff = Date.now() - sinceMs;
    out = out.filter((s) => new Date(s.createdAt).getTime() >= cutoff);
  }
  return out.slice(0, limit);
}

module.exports = {
  start, stop, snapshot, listRecent,
  debugReport,
  getBestSignal,
  computeBetScore,
  // Configs expostas (usadas pelo footballRealtime para filtro tier)
  config: {
    FREE_MIN_CONFIDENCE,
    PREMIUM_MIN_CONFIDENCE,
    FREE_DELAY_MS,
    BEST_TTL_MS,
    DEBUG_MODE,
    TEST_MODE,
    MIN_CONFIDENCE,
    MIN_ODD,
    MAX_ODD,
    MIN_MINUTE,
    MAX_MINUTE,
    COOLDOWN_MS,
  },
  _internals: { computeCornersBet, computeBttsBet, computeWinBet, probToOdd, poisson, premiumInsight },
};
