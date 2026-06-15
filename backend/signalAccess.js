/**
 * Robotrend IA — Controle de Acesso a Sinais por Plano (fonte única de verdade)
 * ============================================================================
 *
 * REGRAS DE NEGÓCIO (obrigatórias):
 *   - PREMIUM (admin/owner/master/premium ou plano pago VIP/PREMIUM/PRO/TRIAL):
 *       vê TODOS os sinais (FREE e PREMIUM) com conteúdo completo.
 *   - FREE:
 *       vê APENAS sinais FREE (com conteúdo, sem a análise profunda premium).
 *       Sinais PREMIUM são SEMPRE ocultados e substituídos por um placeholder
 *       de upgrade — nenhum dado preditivo (palpite, odd, confiança, insight,
 *       times) vaza para o usuário FREE.
 *
 * Toda saída de sinal do servidor (REST, snapshot de socket, broadcast em
 * tempo real) DEVE passar por este módulo antes de chegar ao cliente.
 */

'use strict';

let subscription = null;
try { subscription = require('./subscription'); } catch (_) { subscription = null; }

let freeQuota = null;
try { freeQuota = require('./services/freeSignalQuota'); } catch (_) { freeQuota = null; }

const DEFAULT_PREMIUM_MIN_CONFIDENCE = 75;
let _premiumMin = null;

/** Limiar de confiança que classifica um sinal como PREMIUM (fallback). */
function premiumMinConfidence() {
  if (_premiumMin != null) return _premiumMin;
  try {
    const cfg = require('./services/betSignalEngine').config;
    _premiumMin = Number(cfg && cfg.PREMIUM_MIN_CONFIDENCE) || DEFAULT_PREMIUM_MIN_CONFIDENCE;
  } catch (_) {
    _premiumMin = DEFAULT_PREMIUM_MIN_CONFIDENCE;
  }
  return _premiumMin;
}

const UPGRADE_MESSAGE = 'Sinal exclusivo Premium. Faça upgrade para desbloquear a análise completa.';

/**
 * Mensagem exibida quando um usuário FREE atinge o limite diário de sinais.
 * O número do limite é interpolado a partir da cota corrente (default 4).
 */
function freeLimitMessage() {
  const limit = freeQuota ? freeQuota.dailyLimit() : 4;
  return `Você atingiu o limite diário de ${limit} sinais da versão gratuita.\n\n`
    + 'Desbloqueie acesso completo assinando o Plano Premium e receba todos os sinais, '
    + 'análises avançadas da IA, probabilidades, recomendações e recursos exclusivos.';
}

/**
 * Placeholder de um sinal FREE bloqueado por LIMITE DIÁRIO atingido.
 * Não vaza nenhum dado preditivo — apenas o suficiente para a UI renderizar
 * um card bloqueado com a chamada de upgrade e o aviso do limite.
 */
function lockFreeLimitSignal(signal) {
  const s = signal || {};
  const msg = freeLimitMessage();
  return {
    id: s.id ?? null,
    type: s.type || 'bet:opportunity',
    market: s.market || null,
    tier: 'free',
    locked: true,
    upgrade: true,
    limitReached: true,
    message: msg,
    justification: msg,
    createdAt: s.createdAt || s.created_at || new Date().toISOString(),
  };
}

/**
 * Aplica a cota diária do FREE a um sinal FREE-tier.
 *   - sem ctx.userId (anônimo) → entrega normal (sem rastreio de cota)
 *   - dentro da cota → conteúdo FREE (sem insight premium)
 *   - cota estourada → placeholder de limite diário
 */
function projectFreeTierSignal(signal, ctx) {
  const userId = ctx && ctx.userId != null ? ctx.userId : null;
  if (userId != null && freeQuota) {
    const allowed = freeQuota.tryConsume(userId, signal);
    if (!allowed) return lockFreeLimitSignal(signal);
  }
  return stripFreeInsight(signal);
}

/**
 * O requester (usuário autenticado OU socket.user) tem acesso PREMIUM?
 * Admin/owner/master sempre têm acesso total. Anônimo => false (FREE).
 */
function isPremiumUser(user) {
  if (!user) return false;
  // Fonte de verdade: o módulo de assinatura resolve EXPIRAÇÃO/bloqueio.
  // Um assinante expirado (now > expiresAt) NÃO é premium — mesmo que
  // user.plan ainda seja 'PREMIUM'. Confiamos no resolver e NÃO caímos
  // no fallback ingênuo por plano (que causava "Premium infinito").
  if (subscription && typeof subscription.resolveSubscriptionState === 'function') {
    try {
      if (typeof subscription.isAdminUser === 'function' && subscription.isAdminUser(user)) {
        return true;
      }
      const st = subscription.resolveSubscriptionState(user);
      return !!(st && st.isPremium);
    } catch (_) { /* módulo falhou em runtime → fallback abaixo */ }
  }
  // Fallback APENAS quando o módulo de assinatura está indisponível
  // (não há como avaliar expiração — degrada para checagem por plano/role).
  const role = String(user.role || '').toLowerCase();
  const plan = String(user.plan || '').toUpperCase();
  return role === 'admin' || role === 'owner' || role === 'master' || role === 'super_admin' || role === 'premium'
      || plan === 'PREMIUM' || plan === 'VIP' || plan === 'PRO' || plan === 'TRIAL';
}

/**
 * O sinal é PREMIUM? Usa o `tier` explícito quando presente; caso contrário
 * (sinais legados/persistidos sem tier) deriva da confiança.
 */
function isPremiumSignal(signal) {
  if (!signal) return false;
  const tier = signal.tier ? String(signal.tier).toLowerCase() : '';
  if (tier === 'premium') return true;
  if (tier === 'free') return false;
  const conf = Number(signal.confidence ?? signal.probability ?? 0);
  return conf >= premiumMinConfidence();
}

/**
 * Sinal FREE entregue a usuário FREE: mantém o conteúdo do palpite mas remove
 * a "análise profunda" exclusiva do premium (insight, score, breakdown, extras
 * e o payload bruto persistido, que pode conter campos premium).
 */
function stripFreeInsight(signal) {
  const out = { ...signal };
  delete out.premiumInsight;
  delete out.betScore;
  delete out.scoreBreakdown;
  delete out.extras;
  delete out.payload; // payload JSONB de sinais persistidos pode conter campos premium
  out.tier = 'free';
  out.locked = false;
  return out;
}

/**
 * Placeholder para um sinal PREMIUM ocultado de um usuário FREE.
 * NÃO contém nenhum dado preditivo — apenas o suficiente para a UI renderizar
 * um card bloqueado com chamada de upgrade.
 */
function lockPremiumSignal(signal) {
  const s = signal || {};
  return {
    id: s.id ?? null,
    type: s.type || 'bet:opportunity',
    market: s.market || null,
    tier: 'premium',
    locked: true,
    upgrade: true,
    message: UPGRADE_MESSAGE,
    justification: UPGRADE_MESSAGE,
    createdAt: s.createdAt || s.created_at || new Date().toISOString(),
  };
}

/**
 * Projeta UM sinal para o que o usuário pode ver:
 *   - premium  → sinal completo
 *   - free + sinal premium → placeholder de upgrade (oculta tudo)
 *   - free + sinal free    → sinal com conteúdo, sem insight premium
 *
 * `ctx` (opcional) habilita a COTA DIÁRIA do FREE: passe `{ userId }` para que
 * sinais FREE além do limite diário sejam bloqueados. Sem ctx, mantém o
 * comportamento histórico (sem limite — usado em logs/histórico de sinais).
 */
function projectSignalForUser(signal, isPremium, ctx) {
  if (!signal) return null;
  if (isPremium) return signal;
  if (isPremiumSignal(signal)) return lockPremiumSignal(signal);
  return projectFreeTierSignal(signal, ctx);
}

/** Projeta uma lista de sinais para o que o usuário pode ver. */
function projectSignalsForUser(signals, isPremium, ctx) {
  if (!Array.isArray(signals)) return [];
  if (isPremium) return signals;
  return signals.map((s) => projectSignalForUser(s, false, ctx)).filter(Boolean);
}

/**
 * Broadcast tier-aware no namespace root (io.sockets). Cada socket recebe a
 * projeção correta conforme o plano do seu usuário. Substitui io.emit() direto,
 * que vazava sinais premium para todos.
 */
function broadcastSignalToRoot(io, event, signal) {
  if (!io || !signal) return;
  try {
    for (const [, s] of io.sockets.sockets) {
      if (!s) continue;
      const premium = isPremiumUser(s.user);
      const ctx = (!premium && s.user?.id != null) ? { userId: s.user.id } : undefined;
      const payload = projectSignalForUser(signal, premium, ctx);
      if (payload) s.emit(event, payload);
      // Atualiza o contador "X/limite" do FREE após cada novo sinal.
      if (ctx) emitFreeQuota(s, ctx.userId);
    }
  } catch (_) { /* nunca quebra o pipeline de emissão */ }
}

/** Emite o estado do contador diário do FREE para um socket específico. */
function emitFreeQuota(socket, userId) {
  if (!socket || !freeQuota || userId == null) return;
  try { socket.emit('signal:quota', freeQuota.snapshot(userId)); } catch (_) {}
}

/** Snapshot do contador diário do FREE (para REST/API). */
function freeQuotaSnapshot(userId) {
  if (!freeQuota || userId == null) return null;
  try { return freeQuota.snapshot(userId); } catch (_) { return null; }
}

/* ============================================================
   ANÁLISE AO VIVO (live analysis) — gating por plano
   ------------------------------------------------------------
   A análise ao vivo é PREMIUM. Usuários FREE recebem APENAS dados
   básicos da partida (times, liga, placar, minuto, status e stats
   factuais do placar) + uma mensagem de upgrade. NUNCA recebem:
     • Probabilidades avançadas (perMinute / pressureIndex / projeções)
     • Confiança da IA (analysisScore / confidence / score IA)
     • Odds calculadas (odd / odds / fairOdds)
     • Insights da IA (insight / picks / momentum / bttsLikelihood)
     • Recomendações de entrada (signals / suggestion / prediction)
   ============================================================ */

const LIVE_UPGRADE_MESSAGE =
  'Análise ao vivo completa (probabilidades, confiança da IA, odds, insights e recomendações) disponível apenas no Premium.';

/**
 * Campos PREMIUM (derivados de IA) que NUNCA podem ir para um usuário FREE
 * dentro de um objeto de partida ao vivo. Tudo que não está nesta lista é
 * considerado dado básico/factual de placar e é mantido.
 */
const PREMIUM_MATCH_FIELDS = [
  'perMinute',        // probabilidades avançadas (escanteios/min, chutes/min, pressureIndex)
  'momentum',         // momentum/pressão calculados pela IA
  'pressureIndex',
  'bttsLikelihood',   // probabilidade calculada
  'insight',          // insights da IA (picks / recomendações)
  'signals',          // recomendações de entrada
  'analysis',         // bloco de análise embutido
  'analysisScore',    // confiança/score da IA
  'betScore',
  'score IA',
  'confidence',       // confiança da IA
  'predictions',      // probabilidades/predições calculadas
  'prediction',
  'odds',             // odds calculadas
  'odd',
  'fairOdds',
  'oddEstimated',
  'recommendation',
  'recommendations',
  'picks',
  'aiInsight',
  'premiumInsight',
  'projected',
  'projection',
  'tags',             // tags analíticas da IA
];

/**
 * Remove de um objeto de partida todos os campos premium derivados de IA.
 * Mantém apenas dados básicos/factuais do placar (times, liga, minuto,
 * status, placar, stats brutos) e sinaliza o bloqueio para a UI.
 */
function stripMatchForFree(match) {
  if (!match || typeof match !== 'object') return match;
  const out = { ...match };
  for (const f of PREMIUM_MATCH_FIELDS) delete out[f];
  out.premiumLocked = true;
  out.upgrade = true;
  out.upgradeMessage = LIVE_UPGRADE_MESSAGE;
  return out;
}

/** Projeta UMA partida conforme o plano (premium → completa; free → básica). */
function projectMatchForUser(match, isPremium) {
  if (!match) return match;
  if (isPremium) return match;
  return stripMatchForFree(match);
}

/** Projeta uma LISTA de partidas conforme o plano. */
function projectMatchesForUser(matches, isPremium) {
  if (!Array.isArray(matches)) return matches;
  if (isPremium) return matches;
  return matches.map((m) => stripMatchForFree(m));
}

/**
 * Objeto de análise (analyzer.analyzeLiveMatch) reduzido ao básico para FREE:
 * apenas identificação da partida + placar. Nenhum dado preditivo (confiança,
 * odd, sugestão, pressão, momentum, projeções, etc.).
 */
function basicAnalysisForFree(a) {
  const s = a || {};
  return {
    matchId: s.matchId ?? null,
    home: s.home ?? null,
    away: s.away ?? null,
    league: s.league ?? null,
    minute: s.minute ?? null,
    market: s.market ?? null,
    score: s.snapshot?.score ?? null,
    premiumLocked: true,
    locked: true,
    upgrade: true,
    message: LIVE_UPGRADE_MESSAGE,
    createdAt: s.createdAt || new Date().toISOString(),
  };
}

/** Projeta UM objeto de análise conforme o plano. */
function projectAnalysisForUser(analysis, isPremium) {
  if (!analysis) return analysis;
  if (isPremium) return analysis;
  return basicAnalysisForFree(analysis);
}

/** Projeta uma LISTA de objetos de análise conforme o plano. */
function projectAnalysesForUser(analyses, isPremium) {
  if (!Array.isArray(analyses)) return analyses;
  if (isPremium) return analyses;
  return analyses.map((a) => basicAnalysisForFree(a));
}

/**
 * Projeta o payload de um evento de partida (match:upsert / match:update /
 * match:enriched) conforme o plano. Para FREE, sanitiza `match`/`prev` e
 * remove deltas de campos premium.
 */
function projectMatchEventPayload(payload, isPremium) {
  if (isPremium || !payload || typeof payload !== 'object') return payload;
  const out = { ...payload };
  if (out.match) out.match = stripMatchForFree(out.match);
  if (out.prev) out.prev = stripMatchForFree(out.prev);
  if (out.deltas && typeof out.deltas === 'object') {
    const d = { ...out.deltas };
    for (const f of PREMIUM_MATCH_FIELDS) delete d[f];
    out.deltas = d;
  }
  return out;
}

/**
 * Broadcast tier-aware de uma LISTA de partidas no namespace root.
 * Cada socket recebe a projeção correta conforme o plano do seu usuário.
 */
function broadcastMatchesToRoot(io, event, matches) {
  if (!io) return;
  try {
    for (const [, s] of io.sockets.sockets) {
      if (!s) continue;
      s.emit(event, projectMatchesForUser(matches, isPremiumUser(s.user)));
    }
  } catch (_) { /* nunca quebra o pipeline de emissão */ }
}

/**
 * Broadcast tier-aware de uma LISTA de análises no namespace root.
 */
function broadcastAnalysesToRoot(io, event, analyses) {
  if (!io) return;
  try {
    for (const [, s] of io.sockets.sockets) {
      if (!s) continue;
      s.emit(event, projectAnalysesForUser(analyses, isPremiumUser(s.user)));
    }
  } catch (_) { /* nunca quebra o pipeline de emissão */ }
}

module.exports = {
  UPGRADE_MESSAGE,
  LIVE_UPGRADE_MESSAGE,
  PREMIUM_MATCH_FIELDS,
  premiumMinConfidence,
  isPremiumUser,
  isPremiumSignal,
  stripFreeInsight,
  lockPremiumSignal,
  freeLimitMessage,
  lockFreeLimitSignal,
  projectFreeTierSignal,
  freeQuotaSnapshot,
  emitFreeQuota,
  projectSignalForUser,
  projectSignalsForUser,
  broadcastSignalToRoot,
  stripMatchForFree,
  projectMatchForUser,
  projectMatchesForUser,
  projectAnalysisForUser,
  projectAnalysesForUser,
  projectMatchEventPayload,
  broadcastMatchesToRoot,
  broadcastAnalysesToRoot,
};
