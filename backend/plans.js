/**
 * Robotrend IA — Planos SaaS
 *
 * Definição central de planos + middleware de gating de funcionalidades.
 */

'use strict';

const PLANS = {
  FREE: {
    id: 'FREE',
    label: 'Free',
    priceBRL: 0,
    dailySignals: Number(process.env.PLAN_FREE_DAILY_SIGNALS || 3),
    features: {
      live: true,
      prelive: false,
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
      prelive: true,
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
    priceBRL: Number(process.env.PLAN_PREMIUM_PRICE_BRL || 199.99),
    fullPriceBRL: Number(process.env.PLAN_PREMIUM_FULL_PRICE_BRL || 499.99),
    isPromo: true,
    dailySignals: Number(process.env.PLAN_PREMIUM_DAILY_SIGNALS || 999),
    features: {
      live: true,
      prelive: true,
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
  return Object.values(PLANS);
}

/**
 * Middleware: garante que o usuário tem o feature solicitado.
 * Uso:  app.get('/api/prelive', requireFeature('prelive'), handler)
 */
function requireFeature(featureKey) {
  return (req, res, next) => {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Não autenticado' });
    }
    const plan = getPlan(user.plan);
    if (!plan.features[featureKey]) {
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
  requireFeature,
  dailySignalLimiter,
};
