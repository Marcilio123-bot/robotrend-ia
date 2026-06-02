/**
 * Robotrend IA — Bet Signal Engine v1
 *
 * Motor de sinais focado em VALOR (value betting) para 5 mercados:
 *
 *   1. CORNERS OVER  — Over X.5 escanteios (projeção via ritmo + ataques)
 *   2. CORNERS UNDER — Under X.5 escanteios (mesma projeção, lado oposto)
 *   3. BTTS          — Ambas marcam: Sim / Não (probabilidade Poisson)
 *   4. OVER 2.5      — Total de gols >= 3 (Poisson sobre λ_total restante)
 *   5. UNDER 2.5     — Total de gols <= 2 (1 - P(Over 2.5))
 *
 * WIN (1X2) foi REMOVIDO da geração de sinais (computeWinBet permanece
 * definido mas não entra mais em processMatch).
 *
 * REGRAS GERAIS:
 *   - ZERO chamadas externas de API. Lê apenas `poller.getMatches()` e os
 *     dados já enriquecidos no cache (stats, perMinute, score, etc).
 *   - Tick periódico (default 90s = 1.5min, entre 1–2min como pedido).
 *   - Emite signal:new no event bus → footballRealtime broadcasta no socket.
 *   - Filtros obrigatórios antes de emitir:
 *       confidence  >= 60% (FREE) / 70% (PREMIUM)
 *       oddEstimada in [1.50, 3.00]    (zona de valor ampliada)
 *       minuto      in [20, 85]         (descarta começo/recta-final ruidoso)
 *   - Cooldown por (matchId × market) — não repete o mesmo sinal por 10min.
 *
 * SAÍDA POR SINAL:
 *   {
 *     type: 'bet:opportunity',
 *     market: 'corners' | 'cornersUnder' | 'btts' | 'over25' | 'under25',
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
const FREE_MIN_CONFIDENCE    = Number(process.env.BET_SIGNAL_FREE_MIN_CONFIDENCE    || 60);
// Tier PREMIUM (qualidade — só sinais fortes)
const PREMIUM_MIN_CONFIDENCE = Number(process.env.BET_SIGNAL_PREMIUM_MIN_CONFIDENCE || 70);
// Compat: MIN_CONFIDENCE = piso geral para emitir (= FREE).
// Em TEST_MODE força o piso para TEST_MIN_CONF (default 70).
const MIN_CONFIDENCE = TEST_MODE
  ? TEST_MIN_CONF
  : Math.min(FREE_MIN_CONFIDENCE, Number(process.env.BET_SIGNAL_MIN_CONFIDENCE || FREE_MIN_CONFIDENCE));

const MIN_ODD        = TEST_MODE ? 1.20 : Number(process.env.BET_SIGNAL_MIN_ODD || 1.50);
const MAX_ODD        = TEST_MODE ? 10.0 : Number(process.env.BET_SIGNAL_MAX_ODD || 3.00);
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
   MEMÓRIA PERMANENTE POR FIXTURE — "1 sinal por mercado por jogo"
   ------------------------------------------------------------
   Uma vez que um mercado é EMITIDO para uma fixture, ele NUNCA mais é
   reemitido para essa fixture (mais forte que o cooldown, que é temporal).
   Mercados opostos também travam: emitido um lado, o outro fica proibido.
     emittedMarketsByFixture: { [fixtureId]: { over25, under25, btts,
                                               cornersOver, cornersUnder } }
   ============================================================ */
const emittedMarketsByFixture = new Map();
const OPPOSITE_MARKET_KEY = {
  over25:       'under25',
  under25:      'over25',
  cornersOver:  'cornersUnder',
  cornersUnder: 'cornersOver',
  // 'btts' não tem chave oposta: Sim e Não compartilham a key 'btts',
  // então o gate already-emitted já cobre "BTTS SIM depois BTTS NÃO".
};
function getEmittedMarkets(fixtureId) {
  const id = String(fixtureId);
  let rec = emittedMarketsByFixture.get(id);
  if (!rec) {
    rec = { over25: false, under25: false, btts: false, cornersOver: false, cornersUnder: false };
    emittedMarketsByFixture.set(id, rec);
  }
  return rec;
}
function markMarketEmitted(fixtureId, marketKey) {
  if (!marketKey) return;
  getEmittedMarkets(fixtureId)[marketKey] = true;
}

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
   1b) CORNERS UNDER — Under X.5 escanteios
   ------------------------------------------------------------
   Mercado espelho do Over: usa EXATAMENTE a mesma projeção
   (rate, projected, sigma, sigmoide tanh) de computeCornersBet.
   Não altera nenhuma fórmula existente — apenas seleciona a linha
   onde P(under) está na zona de valor (30–70%) e inverte os bônus
   de corroboração ofensiva (mais pressão ⇒ menor prob de Under).
   ============================================================ */
function computeCornersUnderBet(m) {
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

  if (remaining < 5) return null;

  // RATE — idêntico ao Over (mesma fonte/baseline)
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
    return null;
  }

  const expectedAdd = rate * remaining;
  const projected = total + expectedAdd;
  const sigma = Math.max(0.9, Math.sqrt(Math.max(1, expectedAdd)));

  // Varre targets buscando P(under) ≈ 50% (zona de valor).
  // P(under X.5) = 100 - P(over X.5); usa a MESMA sigmoide do Over.
  let best = null;
  const minTarget = Math.max(Math.floor(total), 4);
  const maxTarget = Math.max(minTarget + 1, Math.ceil(projected) + 4);
  const probsByTarget = [];
  for (let target = minTarget; target <= maxTarget; target++) {
    const z = (projected - (target + 0.5)) / sigma;
    const probOver = clamp(Math.round(50 + 50 * Math.tanh(z * 0.85)), 5, 95);
    const probUnder = 100 - probOver;
    probsByTarget.push({ target, prob: probUnder });
    if (probUnder < 30 || probUnder > 70) continue;
    if (!best || Math.abs(probUnder - 50) < Math.abs(best.prob - 50)) {
      best = { target, prob: probUnder };
    }
  }
  if (!best) {
    if (PIPELINE_LOG) {
      console.log(
        `[CORNERS UNDER] DROP no-target-in-band | fixtureId=${m.fixtureId || m.id} | ` +
        `total=${total} rate=${rate.toFixed(2)} (${rateSource}) projected=${projected.toFixed(1)}`
      );
    }
    return null;
  }

  // Corroboração ofensiva — INVERSA do Over: mais pressão diminui Under.
  let probability = best.prob;
  if (dangBal >= 40) probability -= 3;
  if (pressure >= 60) probability -= 2;
  if (sotBal >= 3)   probability -= 2;
  probability = clamp(probability, 25, 75);

  // Confiança — mesma escala do Over.
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
    const tied = n(m.score?.home) === n(m.score?.away);
    if (tied)        confidence += 5;
    if (min >= 65)   confidence += 5;
  }
  confidence = clamp(confidence, 0, 95);

  return {
    market: 'cornersUnder',
    prediction: `Under ${best.target}.5 escanteios`,
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
      direction: 'under',
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
   2b) GOALS — Over/Under 2.5 gols
   ------------------------------------------------------------
   Modelo: Poisson(λ_total) sobre gols REMANESCENTES.
     λ_total = λ_home + λ_away  (Poissons independentes somam)
   Inputs IDÊNTICOS ao computeBttsBet:
     - minute, score
     - shotsOnTarget, dangerousAttacks, corners (já lidos no fixtureNormalizer)
     - possession + pressure (via baselineXG quando sem stats avançadas)
   Conversão xG → λ usa os MESMOS coeficientes de BTTS:
     SoT × 0.22  Dang × 0.005  Corner × 0.04
   Sem stats avançadas, cai no baselineXG (mesmo fallback de BTTS).

   Probabilidade:
     N_remaining ~ Poisson(λ_total)
     goalsNeeded = 3 - goalsAlready  (>=1 enquanto goalsAlready<3)
     P(Over 2.5)  = P(N_remaining >= goalsNeeded)
     P(Under 2.5) = 1 - P(Over 2.5)

   Já resolvido (3+ gols marcados) → null em ambos os mercados, sem valor.

   Confiança: mesma escala usada em BTTS (45 base + bônus de minuto +
   ritmo de finalização + ataques perigosos balanceados). Não altera
   nem MIN_CONFIDENCE, nem oddRange, nem cooldown — esses gates seguem
   sendo aplicados em processMatch.
   ============================================================ */

/**
 * Helper compartilhado entre Over 2.5 e Under 2.5. Centraliza o cálculo
 * de λ por time + λ_total e a confiança base, garantindo que os dois
 * mercados usem EXATAMENTE os mesmos números.
 */
function _goalsRemainingModel(m) {
  const min = Math.max(1, n(m.minute));
  const remaining = Math.max(0, 95 - min);
  const sh = n(m.score?.home);
  const sa = n(m.score?.away);
  const goalsAlready = sh + sa;

  const sotH = n(m.stats?.shotsOnTarget?.home);
  const sotA = n(m.stats?.shotsOnTarget?.away);
  const dangH = n(m.stats?.dangerousAttacks?.home);
  const dangA = n(m.stats?.dangerousAttacks?.away);
  const cornH = n(m.stats?.corners?.home);
  const cornA = n(m.stats?.corners?.away);
  const advanced = hasAdvancedStats(m);

  // Mesma fórmula de λ usada em computeBttsBet
  function lambdaRestante(sot, dang, corn) {
    const xgAcum = sot * 0.22 + dang * 0.005 + corn * 0.04;
    const xgPorMin = xgAcum / Math.max(1, min);
    return Math.max(0, xgPorMin * remaining);
  }

  let lamH, lamA;
  if (advanced) {
    lamH = lambdaRestante(sotH, dangH, cornH);
    lamA = lambdaRestante(sotA, dangA, cornA);
  } else {
    const base = baselineXG(m);
    lamH = base.lamHRest;
    lamA = base.lamARest;
  }
  const lamTotal = lamH + lamA;

  // P(N_remaining >= goalsNeeded) com Poisson(lamTotal)
  // = 1 - sum_{k=0}^{goalsNeeded-1} P(N=k)
  const goalsNeeded = Math.max(1, 3 - goalsAlready);
  let cdfBelow = 0; // P(N < goalsNeeded) = P(N <= goalsNeeded-1)
  for (let k = 0; k < goalsNeeded; k++) cdfBelow += poisson(lamTotal, k);
  const pOverRaw = clamp(1 - cdfBelow, 0, 1);

  // Confiança — espelha computeBttsBet (45 base + mesmos bônus)
  const sotRate = (sotH + sotA) / Math.max(1, min);
  let confidence = 45;
  if (min >= 35) confidence += 8;
  if (min >= 55) confidence += 8;
  if (min >= 70) confidence += 6;
  if (advanced) {
    if (sotRate >= 0.06)              confidence += 8;
    if (sotRate >= 0.10)              confidence += 4;
    if (Math.min(sotH, sotA) >= 2)    confidence += 8;
    if (Math.min(dangH, dangA) >= 20) confidence += 5;
  } else {
    confidence += 4;                          // base extra (substituí parte do bônus de stats)
    if (min >= 30)            confidence += 4;
    if (min >= 60)            confidence += 4;
    if (goalsAlready >= 1)    confidence += 6; // jogo com gol = mais sinal
  }
  if (goalsAlready >= 1)      confidence += 4;
  confidence = clamp(confidence, 0, 95);

  return {
    min, remaining, sh, sa, goalsAlready, goalsNeeded,
    sotH, sotA, dangH, dangA, cornH, cornA, sotRate,
    advanced,
    lamH, lamA, lamTotal,
    pOverRaw,
    confidence,
  };
}

function computeOver25Bet(m) {
  const r = _goalsRemainingModel(m);
  // Já resolvido: 3+ gols marcados → mercado pago, sem valor sinalizar
  if (r.goalsAlready >= 3) return null;

  const probability = clamp(Math.round(r.pOverRaw * 100), 5, 95);

  return {
    market: 'over25',
    prediction: 'Over 2.5 gols',
    probability,
    confidence: r.confidence,
    oddEstimated: probToOdd(probability),
    justification: r.advanced
      ? (`${r.sh}×${r.sa} em ${r.min}′. SoT H:${r.sotH}/A:${r.sotA}, ataques perigosos ${r.dangH}/${r.dangA}. ` +
         `λ restante=${r.lamTotal.toFixed(2)} (precisa de +${r.goalsNeeded}) → P(Over 2.5)=${probability}%.`)
      : (`${r.sh}×${r.sa} em ${r.min}′ (modelo baseline). λ restante=${r.lamTotal.toFixed(2)} ` +
         `(precisa de +${r.goalsNeeded}) → P(Over 2.5)=${probability}%.`),
    extras: {
      direction: 'over',
      goalsCurrent: r.goalsAlready,
      goalsNeeded: r.goalsNeeded,
      lambdaTotalRemaining: +r.lamTotal.toFixed(2),
      lambdaHomeRemaining: +r.lamH.toFixed(2),
      lambdaAwayRemaining: +r.lamA.toFixed(2),
      baseline: !r.advanced,
    },
  };
}

function computeUnder25Bet(m) {
  const r = _goalsRemainingModel(m);
  // Já resolvido: 3+ gols marcados → Under já perdeu
  if (r.goalsAlready >= 3) return null;

  const pUnder = clamp(1 - r.pOverRaw, 0, 1);
  const probability = clamp(Math.round(pUnder * 100), 5, 95);

  return {
    market: 'under25',
    prediction: 'Under 2.5 gols',
    probability,
    confidence: r.confidence,
    oddEstimated: probToOdd(probability),
    justification: r.advanced
      ? (`${r.sh}×${r.sa} em ${r.min}′. SoT H:${r.sotH}/A:${r.sotA}, ataques perigosos ${r.dangH}/${r.dangA}. ` +
         `λ restante=${r.lamTotal.toFixed(2)} (Over precisaria +${r.goalsNeeded}) → P(Under 2.5)=${probability}%.`)
      : (`${r.sh}×${r.sa} em ${r.min}′ (modelo baseline). λ restante=${r.lamTotal.toFixed(2)} ` +
         `(Over precisaria +${r.goalsNeeded}) → P(Under 2.5)=${probability}%.`),
    extras: {
      direction: 'under',
      goalsCurrent: r.goalsAlready,
      goalsNeeded: r.goalsNeeded,
      lambdaTotalRemaining: +r.lamTotal.toFixed(2),
      lambdaHomeRemaining: +r.lamH.toFixed(2),
      lambdaAwayRemaining: +r.lamA.toFixed(2),
      baseline: !r.advanced,
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

  if (c.market === 'corners' || c.market === 'cornersUnder') {
    const totalCorners = cornH + cornA;
    const totalDang = dangH + dangA;
    const dir = c.market === 'cornersUnder' ? 'Under' : 'Over';
    parts.push(`📊 ${totalCorners} escanteios em ${min}′ (ritmo ${(totalCorners / Math.max(min, 1) * 90).toFixed(1)}/90′) — alvo ${dir}`);
    if (c.market === 'corners') {
      if (totalDang >= 60) parts.push(`⚡ Pressão ofensiva alta: ${totalDang} ataques perigosos`);
      if (sotH + sotA >= 8) parts.push(`🎯 ${sotH + sotA} chutes no alvo — ataques produtivos`);
      const sidePush = cornH > cornA + 2 ? home : cornA > cornH + 2 ? away : null;
      if (sidePush) parts.push(`📈 ${sidePush} dominando a pressão lateral`);
    } else {
      if (totalDang < 40) parts.push(`🛡️ Pressão ofensiva contida: só ${totalDang} ataques perigosos`);
      if (min >= 65) parts.push(`⏱️ ${90 - min}′ restantes — ritmo de escanteios tende a se manter baixo`);
    }
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
  } else if (c.market === 'over25' || c.market === 'under25') {
    const totalSot = sotH + sotA;
    const totalDang = dangH + dangA;
    const goalsCurrent = c.extras?.goalsCurrent ?? 0;
    const goalsNeeded = c.extras?.goalsNeeded ?? null;
    const lamTotal = c.extras?.lambdaTotalRemaining ?? null;
    parts.push(`📊 ${goalsCurrent} gol(s) em ${min}′. SoT total ${totalSot}, ataques perigosos ${totalDang}.`);
    if (lamTotal != null) parts.push(`λ restante=${lamTotal} (precisaria de +${goalsNeeded} para virar Over)`);
    if (c.market === 'over25') {
      if (totalSot >= 8 && min <= 60) parts.push(`🎯 Ritmo ofensivo alto cedo — janela favorável a Over`);
      if (goalsCurrent >= 1)         parts.push(`⚽ Jogo já aberto — precisa de só +${goalsNeeded} gol(s)`);
    } else {
      if (totalSot <= 4 && min >= 60) parts.push(`🛡️ Defesas sólidas (${totalSot} chutes no alvo até ${min}′) — janela curta`);
      if (min >= 75 && goalsCurrent <= 1) parts.push(`⏱️ ${90 - min}′ restantes para Over precisar de +${goalsNeeded}`);
    }
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
    classification: {
      label: c.market.toUpperCase(),
      emoji: c.market === 'corners'      ? '🚩'
           : c.market === 'cornersUnder' ? '🚩'
           : c.market === 'btts'         ? '🎯'
           : c.market === 'over25'       ? '⚽'
           : c.market === 'under25'      ? '🛡️'
           : '🏆',
    },
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

  // ============================================================
  // [SIGNAL TRACE] — 1 linha estruturada por match no input do engine.
  // Mostra exatamente O QUE o engine vai usar nas decisões de mercado.
  // Formato grep-friendly:
  //   [SIGNAL TRACE] fixtureId=X min=Y enriched=t mode=FULL|PARTIAL|MINIMAL
  //   advanced=t corners=8 shots=14 sot=7 dang=78 pressure=2.30
  // ============================================================
  const sigStats = {
    fixtureId: String(m.fixtureId || m.id || ''),
    home: m.home, away: m.away,
    score: `${n(m.score?.home)}-${n(m.score?.away)}`,
    min: n(m.minute),
    enriched: !!m.enriched,
    enrichedPartial: !!m.enrichedPartial,
    advanced,
    corners: n(m.stats?.corners?.home) + n(m.stats?.corners?.away),
    cornersHome: n(m.stats?.corners?.home),
    cornersAway: n(m.stats?.corners?.away),
    shots: n(m.stats?.shots?.home) + n(m.stats?.shots?.away),
    sot: n(m.stats?.shotsOnTarget?.home) + n(m.stats?.shotsOnTarget?.away),
    sotHome: n(m.stats?.shotsOnTarget?.home),
    sotAway: n(m.stats?.shotsOnTarget?.away),
    dang: n(m.stats?.dangerousAttacks?.home) + n(m.stats?.dangerousAttacks?.away),
    dangHome: n(m.stats?.dangerousAttacks?.home),
    dangAway: n(m.stats?.dangerousAttacks?.away),
    pressure: +(n(m.perMinute?.pressureIndex)).toFixed(2),
    possessionHome: n(m.stats?.possession?.home) || 50,
  };
  if (PIPELINE_LOG) {
    console.log(
      `[SIGNAL TRACE] fixtureId=${sigStats.fixtureId} ${sigStats.home} x ${sigStats.away} ` +
      `score=${sigStats.score} min=${sigStats.min} enriched=${sigStats.enriched} ` +
      `mode=${sigStats.enrichedPartial ? 'PARTIAL' : (sigStats.enriched ? 'FULL' : 'NONE')} advanced=${sigStats.advanced} ` +
      `corners=${sigStats.corners}(${sigStats.cornersHome}/${sigStats.cornersAway}) ` +
      `shots=${sigStats.shots} sot=${sigStats.sot}(${sigStats.sotHome}/${sigStats.sotAway}) ` +
      `dang=${sigStats.dang}(${sigStats.dangHome}/${sigStats.dangAway}) ` +
      `pressure=${sigStats.pressure} poss=${sigStats.possessionHome}%`
    );
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

  // === Mercados independentes (corners over/under + BTTS) ===
  const rawCandidates = [
    { market: 'corners',      fn: () => computeCornersBet(m)      }, // cornersOver
    { market: 'cornersUnder', fn: () => computeCornersUnderBet(m) },
    { market: 'btts',         fn: () => computeBttsBet(m)         },
  ];

  // === GOLS (Over/Under 2.5) — MUTUAMENTE EXCLUSIVOS ===
  // Calcula os dois lados (mesmo modelo Poisson), escolhe o de maior
  // probabilidade e exige separação mínima de 10 p.p. (senão market-conflict).
  // Injeta no máximo UM lado de gols por fixture por tick no fluxo de gates.
  const goalsWinner = resolveGoalsWinner(m, sigStats);
  if (goalsWinner) rawCandidates.push({ market: goalsWinner.market, fn: () => goalsWinner });

  for (const { market, fn } of rawCandidates) {
    const c = safe(fn);
    let decision = { market, fixtureId: sigStats.fixtureId, match: `${m.home} x ${m.away}`, min: sigStats.min };

    if (!c) {
      recordFunnel('compute-null');
      recordMarketFunnel(market, 'compute-null');
      recordDrop({ stage: 'compute-null', market, match: matchSummary(m), reason: 'compute returned null (sem dados ou mercado resolvido)' });
      console.log(`${marketTag(market)} fixtureId=${sigStats.fixtureId} ${m.home} x ${m.away} result=DROP reason=compute-null`);
      if (PIPELINE_LOG) console.log(`[LIVE PIPELINE] DROP compute-null | ${m.home} x ${m.away} | market=${market} | motivo=sem dados ou mercado resolvido`);
      decision = { ...decision, result: 'DROP', reason: 'compute-null', detail: 'sem dados ou mercado resolvido' };
      logDecision(decision);
      tickDecisions.push(decision);
      continue;
    }
    recordMarketFunnel(market, 'candidate');
    console.log(`${marketTag(c.market)} fixtureId=${sigStats.fixtureId} ${m.home} x ${m.away} result=CANDIDATE conf=${c.confidence} prob=${c.probability} odd=${c.oddEstimated} pred="${c.prediction}"`);

    if (PIPELINE_LOG) {
      console.log(`[LIVE PIPELINE] candidate ${market} | conf=${c.confidence} | prob=${c.probability} | odd=${c.oddEstimated} | ${c.prediction}`);
    }

    if (c.confidence < MIN_CONFIDENCE) {
      console.log(`${marketTag(c.market)} fixtureId=${sigStats.fixtureId} ${m.home} x ${m.away} result=DROP reason=low-confidence conf=${c.confidence} min=${MIN_CONFIDENCE}`);
      if (PIPELINE_LOG) console.log(`[LIVE PIPELINE] DROP low-confidence | ${m.home} x ${m.away} | market=${c.market} | conf=${c.confidence} < min=${MIN_CONFIDENCE} | pred=${c.prediction}`);
      recordMarketFunnel(c.market, 'low-confidence');
      dropAndLog('low-confidence', m, {
        market: c.market,
        confidence: c.confidence,
        minRequired: MIN_CONFIDENCE,
        probability: c.probability,
        prediction: c.prediction,
      });
      decision = {
        ...decision, result: 'DROP', reason: 'low-confidence',
        confidence: c.confidence, threshold: MIN_CONFIDENCE,
        probability: c.probability, odd: c.oddEstimated, prediction: c.prediction,
        extras: c.extras || null, justification: c.justification || null,
      };
      logDecision(decision);
      tickDecisions.push(decision);
      continue;
    }
    if (c.oddEstimated < MIN_ODD || c.oddEstimated > MAX_ODD) {
      console.log(`${marketTag(c.market)} fixtureId=${sigStats.fixtureId} ${m.home} x ${m.away} result=DROP reason=odd-out-of-range odd=${c.oddEstimated} band=[${MIN_ODD},${MAX_ODD}]`);
      if (PIPELINE_LOG) console.log(`[LIVE PIPELINE] DROP odd-out-of-range | ${m.home} x ${m.away} | market=${c.market} | odd=${c.oddEstimated} fora=[${MIN_ODD},${MAX_ODD}] | conf=${c.confidence} | pred=${c.prediction}`);
      recordMarketFunnel(c.market, 'odd-out-of-range');
      dropAndLog('odd-out-of-range', m, {
        market: c.market,
        oddEstimated: c.oddEstimated,
        oddRange: [MIN_ODD, MAX_ODD],
        confidence: c.confidence,
        probability: c.probability,
        prediction: c.prediction,
      });
      decision = {
        ...decision, result: 'DROP', reason: 'odd-out-of-range',
        odd: c.oddEstimated, oddRange: [MIN_ODD, MAX_ODD],
        confidence: c.confidence, probability: c.probability, prediction: c.prediction,
        extras: c.extras || null, justification: c.justification || null,
      };
      logDecision(decision);
      tickDecisions.push(decision);
      continue;
    }
    // === Dedup PERMANENTE: 1 sinal por mercado por fixture ===
    // Gate aplicado ANTES do cooldown para que repetições do mesmo mercado
    // (ou do mercado oposto) já emitido reportem o motivo correto.
    const marketKey = deriveMarketKey(c.market); // btts|over25|under25|cornersOver|cornersUnder
    const emittedRec = getEmittedMarkets(sigStats.fixtureId);
    if (marketKey && emittedRec[marketKey]) {
      console.log(`${marketTag(c.market)} fixtureId=${sigStats.fixtureId} ${m.home} x ${m.away} result=DROP reason=already-emitted`);
      if (PIPELINE_LOG) console.log(`[LIVE PIPELINE] DROP already-emitted | ${m.home} x ${m.away} | market=${c.market}`);
      recordMarketFunnel(c.market, 'already-emitted');
      dropAndLog('already-emitted', m, { market: c.market, confidence: c.confidence, prediction: c.prediction });
      decision = {
        ...decision, result: 'DROP', reason: 'already-emitted',
        confidence: c.confidence, odd: c.oddEstimated, prediction: c.prediction,
      };
      logDecision(decision);
      tickDecisions.push(decision);
      continue;
    }
    const oppKey = marketKey ? OPPOSITE_MARKET_KEY[marketKey] : null;
    if (oppKey && emittedRec[oppKey]) {
      console.log(`${marketTag(c.market)} fixtureId=${sigStats.fixtureId} ${m.home} x ${m.away} result=DROP reason=opposite-market-already-emitted opposite=${oppKey}`);
      if (PIPELINE_LOG) console.log(`[LIVE PIPELINE] DROP opposite-market-already-emitted | ${m.home} x ${m.away} | market=${c.market} | opposite=${oppKey}`);
      recordMarketFunnel(c.market, 'opposite-market-already-emitted');
      dropAndLog('opposite-market-already-emitted', m, { market: c.market, opposite: oppKey, confidence: c.confidence, prediction: c.prediction });
      decision = {
        ...decision, result: 'DROP', reason: 'opposite-market-already-emitted',
        opposite: oppKey, confidence: c.confidence, odd: c.oddEstimated, prediction: c.prediction,
      };
      logDecision(decision);
      tickDecisions.push(decision);
      continue;
    }

    const key = `${m.fixtureId}:${c.market}`;
    if (!canFire(key)) {
      console.log(`${marketTag(c.market)} fixtureId=${sigStats.fixtureId} ${m.home} x ${m.away} result=DROP reason=cooldown cooldownMs=${COOLDOWN_MS}`);
      if (PIPELINE_LOG) console.log(`[LIVE PIPELINE] DROP cooldown | ${m.home} x ${m.away} | market=${c.market} | cooldownMs=${COOLDOWN_MS} | conf=${c.confidence} | pred=${c.prediction}`);
      recordMarketFunnel(c.market, 'cooldown');
      dropAndLog('cooldown', m, {
        market: c.market,
        cooldownMs: COOLDOWN_MS,
        confidence: c.confidence,
        prediction: c.prediction,
      });
      decision = {
        ...decision, result: 'DROP', reason: 'cooldown',
        cooldownMs: COOLDOWN_MS, confidence: c.confidence,
        odd: c.oddEstimated, prediction: c.prediction,
      };
      logDecision(decision);
      tickDecisions.push(decision);
      continue;
    }
    recordFunnel('emitted');
    recordMarketFunnel(c.market, 'emitted');
    if (tickByMarket && tickByMarket[c.market] !== undefined) {
      tickByMarket[c.market]++;
    }
    console.log(`${marketTag(c.market)} fixtureId=${sigStats.fixtureId} ${m.home} x ${m.away} result=EMIT conf=${c.confidence} prob=${c.probability} odd=${c.oddEstimated} pred="${c.prediction}"`);
    if (PIPELINE_LOG) console.log(`[LIVE PIPELINE] EMIT ${c.market} | ${m.home} x ${m.away} | conf=${c.confidence} | odd=${c.oddEstimated} | ${c.prediction}`);
    decision = {
      ...decision, result: 'EMIT',
      confidence: c.confidence, probability: c.probability, odd: c.oddEstimated,
      prediction: c.prediction, extras: c.extras || null, justification: c.justification || null,
    };
    logDecision(decision);
    tickDecisions.push(decision);
    emit(buildSignal(m, c));
    // Trava permanente: este mercado (e seu oposto) não reemite p/ esta fixture.
    markMarketEmitted(sigStats.fixtureId, marketKey);
  }
}

/**
 * Seleção mutuamente exclusiva do mercado de gols (Over/Under 2.5).
 * ------------------------------------------------------------------
 * Calcula os DOIS lados a partir do mesmo modelo Poisson, mas devolve no
 * máximo UM candidato — o de maior probabilidade — para o fluxo de gates.
 *
 * Regras:
 *   - Ambos null (3+ gols já marcados ou sem dados) → compute-null nos dois.
 *   - abs(pOver - pUnder) < 10 p.p. → DROP reason=market-conflict (nenhum).
 *   - Caso contrário → o lado de MENOR prob é descartado (lower-probability)
 *     e o lado vencedor segue para confidence/odd/cooldown normalmente.
 *
 * Não altera o cálculo (Poisson/λ) — apenas decide qual lado concorre.
 */
function resolveGoalsWinner(m, sigStats) {
  const mkDecision = (market, result, reason, r) => {
    const d = {
      market, fixtureId: sigStats.fixtureId,
      match: `${m.home} x ${m.away}`, min: sigStats.min,
      result, reason,
    };
    if (r) { d.probability = r.probability; d.odd = r.oddEstimated; d.prediction = r.prediction; }
    logDecision(d);
    tickDecisions.push(d);
  };

  const rOver  = safe(() => computeOver25Bet(m));
  const rUnder = safe(() => computeUnder25Bet(m));

  // Ambos sem candidato → jogo resolvido (3+ gols) ou sem dados.
  if (!rOver && !rUnder) {
    for (const mk of ['over25', 'under25']) {
      recordFunnel('compute-null');
      recordMarketFunnel(mk, 'compute-null');
      recordDrop({ stage: 'compute-null', market: mk, match: matchSummary(m), reason: 'goals: mercado resolvido (3+ gols) ou sem dados' });
      console.log(`${marketTag(mk)} fixtureId=${sigStats.fixtureId} ${m.home} x ${m.away} result=DROP reason=compute-null`);
      mkDecision(mk, 'DROP', 'compute-null', null);
    }
    return null;
  }

  // Defensivo: se só um lado existir, ele vira o candidato único.
  if (!rOver || !rUnder) {
    return rOver || rUnder;
  }

  const pOver  = rOver.probability;
  const pUnder = rUnder.probability;
  const diff = Math.abs(pOver - pUnder);

  // Conflito: diferença < 10 p.p. → mercado indefinido, não emite nenhum lado.
  if (diff < 10) {
    for (const r of [rOver, rUnder]) {
      recordMarketFunnel(r.market, 'candidate');
      recordMarketFunnel(r.market, 'market-conflict');
      recordDrop({ stage: 'market-conflict', market: r.market, match: matchSummary(m), reason: `pOver=${pOver}% pUnder=${pUnder}% diff=${diff} < 10` });
      console.log(`${marketTag(r.market)} fixtureId=${sigStats.fixtureId} ${m.home} x ${m.away} result=DROP reason=market-conflict pOver=${pOver} pUnder=${pUnder} diff=${diff}`);
      mkDecision(r.market, 'DROP', 'market-conflict', r);
    }
    if (PIPELINE_LOG) console.log(`[LIVE PIPELINE] DROP market-conflict | ${m.home} x ${m.away} | goals | pOver=${pOver} pUnder=${pUnder} diff=${diff} < 10`);
    return null;
  }

  // Seleciona o lado de maior probabilidade; suprime o outro.
  const winner = pOver >= pUnder ? rOver : rUnder;
  const loser  = pOver >= pUnder ? rUnder : rOver;

  recordMarketFunnel(loser.market, 'candidate');
  recordMarketFunnel(loser.market, 'lower-probability');
  recordDrop({ stage: 'lower-probability', market: loser.market, match: matchSummary(m), reason: `suprimido: menor probabilidade (${loser.probability}% vs ${winner.probability}%)` });
  console.log(`${marketTag(loser.market)} fixtureId=${sigStats.fixtureId} ${m.home} x ${m.away} result=DROP reason=lower-probability prob=${loser.probability} winner=${winner.market}@${winner.probability}`);
  mkDecision(loser.market, 'DROP', 'lower-probability', loser);

  return winner;
}

/**
 * Log estruturado de UMA decisão de mercado.
 * Formato grep-friendly: chave=valor, único line per decisão.
 */
function logDecision(d) {
  pushDecisionToBuffer(d);
  if (!PIPELINE_LOG) return;
  const fields = [
    `fixtureId=${d.fixtureId}`,
    `market=${d.market}`,
    `result=${d.result}`,
    d.reason         ? `reason=${d.reason}`           : null,
    d.confidence != null ? `conf=${d.confidence}`     : null,
    d.threshold  != null ? `threshold=${d.threshold}` : null,
    d.probability != null ? `prob=${d.probability}`   : null,
    d.odd != null    ? `odd=${d.odd}`                 : null,
    d.oddRange       ? `oddBand=${d.oddRange[0]}-${d.oddRange[1]}` : null,
    d.cooldownMs != null ? `cooldownMs=${d.cooldownMs}` : null,
    d.prediction     ? `pred="${d.prediction}"`       : null,
  ].filter(Boolean).join(' ');
  console.log(`[SIGNAL DECISION] ${fields}`);
}

/**
 * Buffer ring por fixture para o endpoint /diag/decisions/:fixtureId.
 * Mantém últimas N decisões para inspeção pós-tick.
 */
const DECISIONS_PER_FIXTURE = Number(process.env.BET_SIGNAL_DECISIONS_PER_FIXTURE || 30);
const decisionBuffer = new Map(); // fixtureId(string) -> Array<{ts, ...decision}>
let tickDecisions = []; // populado por iter, lido no [SIGNAL DROP REPORT]

function pushDecisionToBuffer(d) {
  const id = String(d.fixtureId || '');
  if (!id) return;
  let arr = decisionBuffer.get(id);
  if (!arr) { arr = []; decisionBuffer.set(id, arr); }
  arr.unshift({ ts: Date.now(), ...d });
  if (arr.length > DECISIONS_PER_FIXTURE) arr.length = DECISIONS_PER_FIXTURE;
}

/* ============================================================
   LIFECYCLE
   ============================================================ */
let timer = null;
let started = false;

let lastTickAt = null;
let lastTickSummary = null;
let tickByMarket = { corners: 0, cornersUnder: 0, btts: 0, over25: 0, under25: 0 };
let cornersStats = { withTotal: 0, totalZeroNoAdv: 0, totalZeroWithAdv: 0 };

/* ============================================================
   FUNIL POR MERCADO (instrumentação apenas — não altera lógica)
   ------------------------------------------------------------
   Espelha as 5 categorias pedidas pelo produto:
     btts, over25, under25, cornersOver, cornersUnder
   Para cada categoria contabiliza:
     - candidates: chamadas a compute*Bet() que retornaram um candidato
     - emitted:    candidatos que passaram TODOS os gates e foram emitidos
     - drops:      contagem por motivo (compute-null, low-confidence,
                   odd-out-of-range, cooldown).

   Mercados que o engine ainda NÃO calcula (over25, under25, cornersUnder)
   permanecem zerados em candidates/emitted e recebem o motivo sintético
   `market-not-implemented` igual ao número de matches que entraram no
   estágio per-market (`computed`) — assim fica explícito no relatório
   que o mercado é estrutural, não um descarte por filtro.
   ============================================================ */
const MARKET_KEYS = ['btts', 'over25', 'under25', 'cornersOver', 'cornersUnder'];
function makeMarketFunnel() {
  const out = {};
  for (const k of MARKET_KEYS) out[k] = { candidates: 0, emitted: 0, drops: {} };
  return out;
}
let tickByMarketFunnel = makeMarketFunnel();
const totalsByMarketFunnel = makeMarketFunnel();

/**
 * Mapeia (market interno, candidato) -> chave do funil por mercado.
 *  - 'corners' interno só calcula Over X.5  -> sempre cornersOver
 *  - 'btts'    interno cobre Sim e Não      -> sempre btts
 *  - 'over25'  -> over25
 *  - 'under25' -> under25
 *  - 'win'     NÃO está nos 5 mercados pedidos -> ignorado
 */
function deriveMarketKey(internalMarket /*, candidate */) {
  if (internalMarket === 'btts') return 'btts';
  if (internalMarket === 'corners') return 'cornersOver';
  if (internalMarket === 'cornersUnder') return 'cornersUnder';
  if (internalMarket === 'over25') return 'over25';
  if (internalMarket === 'under25') return 'under25';
  return null;
}

/**
 * Tag de log por mercado, exigida pelo produto:
 *   [BTTS] [GOALS OVER25] [GOALS UNDER25] [CORNERS OVER] [CORNERS UNDER]
 * 'win' não é mais gerado; mapeado defensivamente.
 */
const MARKET_LOG_TAG = {
  btts:         '[BTTS]',
  over25:       '[GOALS OVER25]',
  under25:      '[GOALS UNDER25]',
  corners:      '[CORNERS OVER]',
  cornersUnder: '[CORNERS UNDER]',
  win:          '[WIN]',
};
function marketTag(market) {
  return MARKET_LOG_TAG[market] || `[${String(market || '?').toUpperCase()}]`;
}

function recordMarketFunnel(internalMarket, stage) {
  const key = deriveMarketKey(internalMarket);
  if (!key) return;
  const tickB = tickByMarketFunnel[key];
  const totB  = totalsByMarketFunnel[key];
  if (!tickB || !totB) return;
  if (stage === 'candidate') {
    tickB.candidates++; totB.candidates++;
  } else if (stage === 'emitted') {
    tickB.emitted++; totB.emitted++;
  } else {
    tickB.drops[stage] = (tickB.drops[stage] || 0) + 1;
    totB.drops[stage]  = (totB.drops[stage]  || 0) + 1;
  }
}

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
    tickByMarket = { corners: 0, cornersUnder: 0, btts: 0, over25: 0, under25: 0 };
    tickByMarketFunnel = makeMarketFunnel();
    cornersStats = { withTotal: 0, totalZeroNoAdv: 0, totalZeroWithAdv: 0 };
    tickDecisions = []; // populado dentro de processMatch via logDecision
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
      `emitted: cornersOver=${tickByMarket.corners} cornersUnder=${tickByMarket.cornersUnder} ` +
      `btts=${tickByMarket.btts} over25=${tickByMarket.over25} under25=${tickByMarket.under25}`
    );

    // [SIGNAL DROP REPORT] — agregado por (market, reason) deste tick.
    // Mostra exatamente onde a maioria dos sinais está sendo cortada.
    // Útil pra responder "ENRICH=true gerou poucos sinais — qual filtro
    // pegou?": tipicamente low-confidence ou odd-out-of-range.
    try {
      const agg = {};
      for (const d of tickDecisions) {
        const key = `${d.market}/${d.result === 'EMIT' ? 'EMIT' : ('DROP:' + (d.reason || '?'))}`;
        if (!agg[key]) agg[key] = { count: 0, samples: [] };
        agg[key].count++;
        if (agg[key].samples.length < 3) {
          agg[key].samples.push({
            fixtureId: d.fixtureId,
            conf: d.confidence ?? null,
            prob: d.probability ?? null,
            odd: d.odd ?? null,
            pred: d.prediction || null,
          });
        }
      }
      const breakdown = Object.entries(agg)
        .sort((a, b) => b[1].count - a[1].count)
        .map(([k, v]) => `${k}=${v.count}`)
        .join(' ');
      console.log(`[SIGNAL DROP REPORT] tick: decisions=${tickDecisions.length} | ${breakdown || '(no decisions)'}`);
      // Detalhe por linha das top-3 razões (com amostras p/ debug rápido)
      const top = Object.entries(agg)
        .filter(([k]) => k.includes('DROP:'))
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 3);
      for (const [k, v] of top) {
        const s = v.samples.map((x) =>
          `[fx=${x.fixtureId} conf=${x.conf} prob=${x.prob} odd=${x.odd} pred="${(x.pred || '').slice(0, 40)}"]`
        ).join(' ');
        console.log(`[SIGNAL DROP REPORT] ${k} ×${v.count} samples=${s}`);
      }
    } catch (_) { /* nunca quebrar tick por log */ }
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
    const pHi = Math.round(100 / MIN_ODD);
    const pLo = Math.round(100 / MAX_ODD);
    hints.push(`Faixa de odd [${MIN_ODD}, ${MAX_ODD}] está cortando candidatos. Sinais com prob > ${pHi}% (odd < ${MIN_ODD}) ou < ${pLo}% (odd > ${MAX_ODD}) são descartados.`);
  }
  if ((breakdown.cooldown?.count || 0) > inP * 0.3) {
    hints.push('Muitos sinais bloqueados por cooldown (10min). Em ambiente de teste, BET_SIGNAL_TEST_MODE=true desliga o cooldown.');
  }
  if (!hints.length) {
    hints.push('Pipeline saudável — nenhum gargalo óbvio. Se sinais ainda não aparecem, rode `node scripts/diagnose-signals.js` para detalhes.');
  }
  return hints;
}

/**
 * Funil completo por mercado, no formato pedido pelo endpoint
 * GET /api/football/bet-signals/diag/markets.
 *
 * Retorna 5 chaves (btts, over25, under25, cornersOver, cornersUnder)
 * com:
 *   - candidates : compute*Bet() != null neste tick / acumulado
 *   - emitted    : sinais que passaram TODOS os gates
 *   - drops      : { reason: count }
 *
 * Inclui também `preGate` (estágios anteriores ao loop de mercados)
 * e `markets.lastTick` para diagnóstico do último ciclo.
 */
// Motivos de drop sempre presentes na resposta por mercado (default 0).
// 'market-conflict' / 'lower-probability' aplicam-se ao par de gols (Over/Under).
const MARKET_DROP_KEYS = ['compute-null', 'low-confidence', 'odd-out-of-range', 'cooldown', 'market-conflict', 'lower-probability', 'already-emitted', 'opposite-market-already-emitted'];
function normalizeMarketEntry(src) {
  const drops = {};
  for (const r of MARKET_DROP_KEYS) drops[r] = (src?.drops?.[r]) || 0;
  // preserva quaisquer outros motivos que apareçam, sem perder os defaults
  for (const [r, v] of Object.entries(src?.drops || {})) {
    if (!(r in drops)) drops[r] = v;
  }
  return {
    candidates: src?.candidates || 0,
    emitted: src?.emitted || 0,
    drops,
  };
}

function getMarketFunnel() {
  const totals = {};
  for (const k of MARKET_KEYS) {
    totals[k] = normalizeMarketEntry(totalsByMarketFunnel[k]);
  }

  // Espelho do último tick (snapshot transitório). Útil para confirmar
  // que o funil está sendo populado em tempo real.
  const lastTick = {};
  for (const k of MARKET_KEYS) {
    lastTick[k] = normalizeMarketEntry(tickByMarketFunnel[k]);
  }

  return {
    markets: totals,
    lastTick,
    preGate: {
      input:                 funnelTotals.input || 0,
      'not-enriched':        funnelTotals['not-enriched'] || 0,
      'no-stats':            funnelTotals['no-stats'] || 0,
      'minute-out-of-range': funnelTotals['minute-out-of-range'] || 0,
      computed:              funnelTotals.computed || 0,
    },
    thresholds: {
      minConfidence: MIN_CONFIDENCE,
      oddRange: { min: MIN_ODD, max: MAX_ODD },
      minuteRange: { min: MIN_MINUTE, max: MAX_MINUTE },
      cooldownMs: COOLDOWN_MS,
    },
    notes: {
      btts:          'Implementado em computeBttsBet. Cobre direções Sim e Não (extras.direction).',
      over25:        'Implementado em computeOver25Bet (Poisson sobre λ_total restante).',
      under25:       'Implementado em computeUnder25Bet (1 - P(Over 2.5) sobre o mesmo λ).',
      cornersOver:   'Implementado em computeCornersBet (Over X.5 dinâmico).',
      cornersUnder:  'Implementado em computeCornersUnderBet (Under X.5, mesma projeção do Over).',
    },
    lastTickAt,
    generatedAt: new Date().toISOString(),
  };
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

/**
 * Devolve as últimas N decisões para um fixtureId específico.
 * Usado pelo endpoint /api/football/bet-signals/diag/decisions/:id.
 */
function getDecisionsFor(fixtureId, { limit = 30 } = {}) {
  const arr = decisionBuffer.get(String(fixtureId)) || [];
  return arr.slice(0, Math.max(1, Math.min(limit, DECISIONS_PER_FIXTURE)));
}

/** Lista todos os fixtureIds com decisões em buffer (mais recentes primeiro). */
function listDecisionFixtures({ limit = 50 } = {}) {
  return [...decisionBuffer.entries()]
    .map(([id, arr]) => ({
      fixtureId: id,
      decisions: arr.length,
      lastDecisionAt: arr[0]?.ts || null,
      lastResult: arr[0]?.result || null,
      lastMarket: arr[0]?.market || null,
    }))
    .sort((a, b) => (b.lastDecisionAt || 0) - (a.lastDecisionAt || 0))
    .slice(0, limit);
}

module.exports = {
  start, stop, snapshot, listRecent,
  debugReport,
  getMarketFunnel,
  getDecisionsFor, listDecisionFixtures,
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
  _internals: {
    computeCornersBet, computeCornersUnderBet, computeBttsBet,
    computeOver25Bet, computeUnder25Bet,
    computeWinBet,
    probToOdd, poisson, premiumInsight,
  },
};
