/**
 * Robotrend IA — Planos SaaS
 *
 * Definição central de planos + middleware de gating de funcionalidades.
 */

'use strict';

const subscription = require('./subscription');

const PLANS = {
  FREE: {
    id: 'FREE',
    label: 'Free',
    priceBRL: 0,
    dailySignals: Number(process.env.PLAN_FREE_DAILY_SIGNALS || 4),
    features: {
      live: true,
      btts: true,
      over25: false,
      telegramAlerts: false,
      historyDays: 7,
      api: false,
    },
  },
  VIP: {
    id: 'VIP',
    label: 'VIP',
    priceBRL: Number(process.env.PLAN_VIP_PRICE_BRL || 49.9),
    dailySignals: Number(process.env.PLAN_VIP_DAILY_SIGNALS || 30),
    features: {
      live: true,
      btts: true,
      over25: true,
      telegramAlerts: true,
      historyDays: 30,
      api: false,
    },
  },
  PREMIUM: {
    id: 'PREMIUM',
    label: 'Premium',
    priceBRL: Number(process.env.PLAN_PREMIUM_PRICE_BRL || 49.99),
    billingCycle: 'monthly',
    durationDays: Number(process.env.PLAN_PREMIUM_DURATION_DAYS || 30),
    recurring: true,
    dailySignals: Number(process.env.PLAN_PREMIUM_DAILY_SIGNALS || 999),
    features: {
      live: true,
      btts: true,
      over25: true,
      telegramAlerts: true,
      historyDays: 365,
      api: true,
    },
  },
  // Ciclos de pré-pagamento do Premium — mesmo acesso, validade maior e preço único.
  // Geram comissão de afiliado automaticamente (sobre o valor pago).
  SEMESTRAL: {
    id: 'SEMESTRAL',
    label: 'Premium Semestral',
    priceBRL: Number(process.env.PLAN_SEMESTRAL_PRICE_BRL || 249.99),
    billingCycle: 'semiannual',
    durationDays: Number(process.env.PLAN_SEMESTRAL_DURATION_DAYS || 180),
    recurring: false,
    dailySignals: Number(process.env.PLAN_PREMIUM_DAILY_SIGNALS || 999),
    features: {
      live: true,
      btts: true,
      over25: true,
      telegramAlerts: true,
      historyDays: 365,
      api: true,
    },
  },
  ANUAL: {
    id: 'ANUAL',
    label: 'Premium Anual',
    priceBRL: Number(process.env.PLAN_ANUAL_PRICE_BRL || 499.99),
    billingCycle: 'annual',
    durationDays: Number(process.env.PLAN_ANUAL_DURATION_DAYS || 365),
    recurring: false,
    dailySignals: Number(process.env.PLAN_PREMIUM_DAILY_SIGNALS || 999),
    features: {
      live: true,
      btts: true,
      over25: true,
      telegramAlerts: true,
      historyDays: 365,
      api: true,
    },
  },
};

function getPlan(planId) {
  return PLANS[planId] || PLANS.FREE;
}

function listPlans() {
  // Oferta pública: modelo 100% mensal — apenas Free + Premium (R$ 49,99/mês).
  // VIP permanece definido para compatibilidade com assinantes legados/admin,
  // mas não é mais ofertado nas telas de planos.
  return [PLANS.FREE, PLANS.PREMIUM];
}

/**
 * Ciclos de assinatura Premium ofertados (mensal, semestral, anual).
 * Todos liberam o mesmo acesso Premium; mudam preço e validade.
 */
function listPremiumCycles() {
  return [PLANS.PREMIUM, PLANS.SEMESTRAL, PLANS.ANUAL].map((p) => ({
    id: p.id,
    label: p.label,
    priceBRL: p.priceBRL,
    billingCycle: p.billingCycle,
    durationDays: p.durationDays,
    recurring: !!p.recurring,
  }));
}

/**
 * Middleware: garante que o usuário tem o feature solicitado.
 * Uso:  app.get('/api/rota', requireFeature('over25'), handler)
 */
function requireFeature(featureKey) {
  return (req, res, next) => {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Não autenticado' });
    }
    if (!subscription.isAdminUser(user)) {
      const sub = req.subscription || subscription.resolveSubscriptionState(user);
      if (sub.blocked || sub.subscriptionStatus === subscription.STATUS.BLOCKED) {
        return res.status(403).json({
          error: 'Sua conta foi bloqueada. Entre em contato com o suporte.',
          code: 'ACCOUNT_BLOCKED',
        });
      }
      if (sub.subscriptionStatus === subscription.STATUS.EXPIRED || !sub.hasPaidAccess) {
        const planDef = getPlan(user.plan);
        if (planDef.features[featureKey] && subscription.isPaidPlan(user.plan)) {
          return res.status(403).json({
            error: 'Sua assinatura expirou. Renove para continuar.',
            code: 'SUBSCRIPTION_EXPIRED',
            upgrade: true,
          });
        }
      }
    }
    const plan = getPlan(user.plan);
    const sub = req.subscription || subscription.resolveSubscriptionState(user);
    const effectivePlan = (subscription.isAdminUser(user) || sub.hasPaidAccess)
      ? plan
      : getPlan('FREE');
    if (!effectivePlan.features[featureKey]) {
      return res.status(402).json({
        error: 'Funcionalidade exclusiva de plano superior',
        feature: featureKey,
        currentPlan: plan.id,
        upgrade: true,
      });
    }
    next();
  };
}

/**
 * Middleware: limita sinais diários conforme plano.
 * Espera req.user.id e usa `db` para contar sinais do dia.
 */
function dailySignalLimiter(db) {
  return async (req, res, next) => {
    const user = req.user;
    if (!user) return res.status(401).json({ error: 'Não autenticado' });
    const plan = getPlan(user.plan);
    try {
      const count = await db.countTodaySignalsForUser(user.id);
      if (count >= plan.dailySignals) {
        return res.status(429).json({
          error: 'Limite diário de sinais atingido',
          plan: plan.id,
          limit: plan.dailySignals,
          used: count,
          upgrade: true,
        });
      }
      req.signalLimit = { used: count, limit: plan.dailySignals };
      next();
    } catch (e) {
      next(e);
    }
  };
}

module.exports = {
  PLANS,
  getPlan,
  listPlans,
  listPremiumCycles,
  requireFeature,
  dailySignalLimiter,
};
