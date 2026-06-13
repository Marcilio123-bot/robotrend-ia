/**
 * Robotrend IA — Sistema de Assinaturas
 * ---------------------------------------------------------------
 * Controle central de planos, expiração, bloqueio e acesso.
 *
 * Campos do usuário (users):
 *   plan, expiresAt, blocked, blockedReason, subscriptionStatus
 *
 * Status: active | expired | blocked
 */

'use strict';

const { logger } = require('./logger');
const log = logger.child({ module: 'subscription' });

const STATUS = {
  ACTIVE: 'active',
  EXPIRED: 'expired',
  BLOCKED: 'blocked',
};

const PAID_PLANS = new Set(['PREMIUM', 'VIP', 'PRO', 'SEMESTRAL', 'ANUAL']);

/** Dias de validade por ciclo de cobrança (pagamento ou renovação admin).
 *  Premium é mensal recorrente (30 dias por ciclo).
 *  Semestral/Anual são pré-pagos (180/365 dias). */
const PLAN_DURATION_DAYS = {
  PREMIUM: Number(process.env.PLAN_PREMIUM_DURATION_DAYS || 30),
  VIP: Number(process.env.PLAN_VIP_DURATION_DAYS || 365),
  PRO: Number(process.env.PLAN_PREMIUM_DURATION_DAYS || 30),
  SEMESTRAL: Number(process.env.PLAN_SEMESTRAL_DURATION_DAYS || 180),
  ANUAL: Number(process.env.PLAN_ANUAL_DURATION_DAYS || 365),
};

function normalizePlan(plan) {
  return String(plan || 'FREE').toUpperCase();
}

const PRIVILEGED_ROLES = new Set(['admin', 'owner', 'master', 'super_admin']);

function isAdminUser(user) {
  const role = String(user?.role || '').toLowerCase();
  return PRIVILEGED_ROLES.has(role);
}

/**
 * Define role após mudança de plano SEM rebaixar administradores.
 * Plano (FREE/VIP/PREMIUM) é independente do privilégio de painel master.
 */
function resolveSubscriptionRole(currentRole, plan) {
  if (isAdminUser({ role: currentRole })) return String(currentRole || 'admin').toLowerCase();
  const p = normalizePlan(plan);
  return p === 'FREE' ? 'user' : 'premium';
}

/** E-mail padrão do bootstrap (mesmo valor de services/bootstrapAdmin.js). */
const DEFAULT_BOOTSTRAP_EMAIL = 'admin@robotrend.local';

/** E-mails que devem manter role master/admin (bootstrap + lista extra). */
function privilegedAdminEmails() {
  const emails = new Set();
  const boot = String(process.env.BOOTSTRAP_ADMIN_EMAIL || DEFAULT_BOOTSTRAP_EMAIL).trim().toLowerCase();
  if (boot) emails.add(boot);
  emails.add(DEFAULT_BOOTSTRAP_EMAIL);
  const extra = String(process.env.ADMIN_EMAILS || '').split(',');
  for (const e of extra) {
    const x = e.trim().toLowerCase();
    if (x) emails.add(x);
  }
  return emails;
}

function isPrivilegedAdminEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  return e && privilegedAdminEmails().has(e);
}

function isPaidPlan(plan) {
  return PAID_PLANS.has(normalizePlan(plan));
}

function addDays(fromDate, days) {
  const base = fromDate instanceof Date ? fromDate.getTime() : Date.now();
  return new Date(base + Number(days) * 24 * 3600 * 1000);
}

function durationDaysForPlan(plan) {
  const p = normalizePlan(plan);
  return PLAN_DURATION_DAYS[p] || 0;
}

/**
 * Calcula estado efetivo da assinatura (sem persistir).
 */
function resolveSubscriptionState(user) {
  if (!user) {
    return {
      subscriptionStatus: STATUS.ACTIVE,
      blocked: false,
      expiresAt: null,
      daysRemaining: null,
      hasPaidAccess: false,
      isPremium: false,
      isVip: false,
    };
  }

  if (isAdminUser(user) || isPrivilegedAdminEmail(user?.email)) {
    return {
      subscriptionStatus: STATUS.ACTIVE,
      blocked: false,
      blockedReason: null,
      expiresAt: user.expiresAt || null,
      daysRemaining: null,
      hasPaidAccess: true,
      isPremium: true,
      isVip: true,
      plan: normalizePlan(user.plan),
    };
  }

  const plan = normalizePlan(user.plan);
  const blocked = user.blocked === true || user.active === false;
  let status = String(user.subscriptionStatus || STATUS.ACTIVE).toLowerCase();

  if (blocked) {
    status = STATUS.BLOCKED;
  } else if (isPaidPlan(plan) && user.expiresAt) {
    const exp = new Date(user.expiresAt).getTime();
    if (Number.isFinite(exp) && exp < Date.now()) {
      status = STATUS.EXPIRED;
    } else if (status === STATUS.EXPIRED && Number.isFinite(exp) && exp >= Date.now()) {
      status = STATUS.ACTIVE;
    }
  } else if (isPaidPlan(plan) && !user.expiresAt) {
    // Compat: usuário pago sem data — trata como ativo até migração preencher
    status = status === STATUS.BLOCKED ? STATUS.BLOCKED : STATUS.ACTIVE;
  } else if (!isPaidPlan(plan)) {
    status = blocked ? STATUS.BLOCKED : STATUS.ACTIVE;
  }

  let daysRemaining = null;
  if (user.expiresAt && isPaidPlan(plan)) {
    const exp = new Date(user.expiresAt).getTime();
    if (Number.isFinite(exp)) {
      daysRemaining = Math.max(0, Math.ceil((exp - Date.now()) / (24 * 3600 * 1000)));
    }
  }

  const hasPaidAccess = isPaidPlan(plan) && status === STATUS.ACTIVE && !blocked;
  const isVip = hasPaidAccess && plan === 'VIP';
  // Qualquer plano pago ativo (incl. SEMESTRAL/ANUAL) concede acesso Premium.
  const isPremium = hasPaidAccess;

  return {
    subscriptionStatus: status,
    blocked,
    blockedReason: user.blockedReason || null,
    expiresAt: user.expiresAt || null,
    daysRemaining,
    hasPaidAccess,
    isPremium,
    isVip,
    plan,
  };
}

/**
 * Persiste status expirado no banco quando detectado (lazy, no auth).
 */
async function syncSubscriptionStatus(db, user) {
  if (!user?.id) return user;
  const resolved = resolveSubscriptionState(user);
  const patch = {};
  if (resolved.subscriptionStatus !== (user.subscriptionStatus || STATUS.ACTIVE)) {
    patch.subscriptionStatus = resolved.subscriptionStatus;
  }
  if (resolved.blocked !== !!user.blocked) patch.blocked = resolved.blocked;
  if (Object.keys(patch).length === 0) return { ...user, ...resolved };
  try {
    const updated = await db.updateUser(user.id, patch);
    return { ...(updated || user), ...resolveSubscriptionState(updated || user) };
  } catch (err) {
    // Migração 004 ainda não aplicada (colunas expires_at/blocked/subscription_status)
    const missingCol = err?.code === '42703' || /column.*does not exist/i.test(String(err?.message || ''));
    if (missingCol) {
      log.warn('syncSubscriptionStatus: colunas de assinatura ausentes — rode a migração 004', {
        userId: user.id, err: err.message,
      });
      return { ...user, ...resolved };
    }
    throw err;
  }
}

/**
 * Ativa assinatura após pagamento ou renovação admin.
 */
async function activateSubscription(db, userId, { plan, provider, externalId, fromDate } = {}) {
  const existing = await db.findUserById(userId);
  const p = normalizePlan(plan);
  const days = durationDaysForPlan(p);
  const expiresAt = days > 0 ? addDays(fromDate || new Date(), days) : null;
  const role = resolveSubscriptionRole(existing?.role, p);

  await db.updateUser(userId, {
    plan: p,
    role,
    blocked: false,
    blockedReason: null,
    subscriptionStatus: STATUS.ACTIVE,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    active: true,
  });

  if (expiresAt && typeof db.upsertSubscription === 'function') {
    await db.upsertSubscription(userId, {
      plan: p,
      provider: provider || 'manual',
      externalId: externalId || null,
      status: 'active',
      expiresAt,
    });
  }

  return db.findUserById(userId);
}

async function blockUser(db, userId, { reason, adminId, adminEmail } = {}) {
  const user = await db.findUserById(userId);
  if (!user) return null;
  await db.updateUser(userId, {
    blocked: true,
    blockedReason: reason || null,
    subscriptionStatus: STATUS.BLOCKED,
    active: false,
  });
  await logAdminAction(db, {
    adminId, adminEmail,
    action: 'user.block',
    targetUserId: userId,
    targetEmail: user.email,
    details: { reason: reason || null },
  });
  log.warn('usuário bloqueado', { userId, email: user.email, adminId });
  return db.findUserById(userId);
}

async function unblockUser(db, userId, { adminId, adminEmail } = {}) {
  const user = await db.findUserById(userId);
  if (!user) return null;
  const resolved = resolveSubscriptionState({ ...user, blocked: false, active: true });
  let status = STATUS.ACTIVE;
  if (isPaidPlan(user.plan) && user.expiresAt) {
    const exp = new Date(user.expiresAt).getTime();
    if (Number.isFinite(exp) && exp < Date.now()) status = STATUS.EXPIRED;
  }
  await db.updateUser(userId, {
    blocked: false,
    blockedReason: null,
    subscriptionStatus: status,
    active: true,
  });
  await logAdminAction(db, {
    adminId, adminEmail,
    action: 'user.unblock',
    targetUserId: userId,
    targetEmail: user.email,
    details: {},
  });
  log.info('usuário desbloqueado', { userId, email: user.email, adminId });
  return db.findUserById(userId);
}

/**
 * Renova assinatura: Premium +30d (mensal), VIP +365d (legado).
 * Acumula a partir do maior entre agora e expiresAt.
 */
async function renewSubscription(db, userId, { adminId, adminEmail, plan: planOverride } = {}) {
  const user = await db.findUserById(userId);
  if (!user) return null;
  const plan = normalizePlan(planOverride || user.plan);
  if (!isPaidPlan(plan)) {
    const err = new Error('Renovação disponível apenas para planos Premium ou VIP');
    err.status = 400;
    throw err;
  }
  const days = durationDaysForPlan(plan);
  const currentExp = user.expiresAt ? new Date(user.expiresAt).getTime() : 0;
  const base = currentExp > Date.now() ? new Date(currentExp) : new Date();
  const expiresAt = addDays(base, days);

  await db.updateUser(userId, {
    plan,
    role: resolveSubscriptionRole(user.role, plan),
    expiresAt: expiresAt.toISOString(),
    subscriptionStatus: STATUS.ACTIVE,
    blocked: false,
    blockedReason: null,
    active: true,
  });

  if (typeof db.upsertSubscription === 'function') {
    await db.upsertSubscription(userId, {
      plan,
      provider: 'admin_renewal',
      status: 'active',
      expiresAt,
    });
  }

  await logAdminAction(db, {
    adminId, adminEmail,
    action: 'user.renew',
    targetUserId: userId,
    targetEmail: user.email,
    details: { plan, days, expiresAt: expiresAt.toISOString() },
  });

  log.info('assinatura renovada', {
    userId, email: user.email, plan, days, expiresAt: expiresAt.toISOString(), adminId,
  });

  return db.findUserById(userId);
}

async function logAdminAction(db, entry) {
  if (typeof db.saveAdminLog === 'function') {
    try {
      await db.saveAdminLog(entry);
    } catch (err) {
      log.warn('saveAdminLog falhou', { err: err.message });
    }
  }
}

/** Enriquece user sanitizado com campos de assinatura para API/UI. */
function enrichUserForClient(user) {
  const state = resolveSubscriptionState(user);
  const admin = isAdminUser(user) || isPrivilegedAdminEmail(user?.email);
  return {
    ...user,
    subscriptionStatus: state.subscriptionStatus,
    blocked: state.blocked,
    blockedReason: state.blockedReason,
    expiresAt: state.expiresAt,
    daysRemaining: state.daysRemaining,
    isAdmin: admin,
    isPremium: state.isPremium,
    isVip: state.isVip,
    hasPaidAccess: state.hasPaidAccess,
  };
}

/* ============================================================
   MIDDLEWARE
   ============================================================ */

function attachSubscription(req, res, next) {
  if (!req.user) return next();
  const enriched = enrichUserForClient(req.user);
  req.user = enriched;
  req.subscription = resolveSubscriptionState(enriched);
  next();
}

function requireNotBlocked(req, res, next) {
  const sub = req.subscription || resolveSubscriptionState(req.user);
  if (sub.blocked || sub.subscriptionStatus === STATUS.BLOCKED) {
    return res.status(403).json({
      error: 'Sua conta foi bloqueada. Entre em contato com o suporte.',
      code: 'ACCOUNT_BLOCKED',
    });
  }
  next();
}

function requireActiveSubscription(req, res, next) {
  const sub = req.subscription || resolveSubscriptionState(req.user);
  if (isAdminUser(req.user)) return next();
  if (sub.subscriptionStatus === STATUS.EXPIRED) {
    return res.status(403).json({
      error: 'Sua assinatura expirou. Renove para continuar usando os recursos Premium.',
      code: 'SUBSCRIPTION_EXPIRED',
      expiresAt: sub.expiresAt,
    });
  }
  if (!sub.hasPaidAccess && isPaidPlan(sub.plan)) {
    return res.status(403).json({
      error: 'Assinatura inativa. Renove para continuar.',
      code: 'SUBSCRIPTION_INACTIVE',
    });
  }
  next();
}

/** Exige plano pago ativo (Premium ou VIP). */
function requirePaidPlan(minPlan) {
  return (req, res, next) => {
    const sub = req.subscription || resolveSubscriptionState(req.user);
    if (isAdminUser(req.user)) return next();
    if (sub.blocked || sub.subscriptionStatus === STATUS.BLOCKED) {
      return res.status(403).json({
        error: 'Sua conta foi bloqueada. Entre em contato com o suporte.',
        code: 'ACCOUNT_BLOCKED',
      });
    }
    if (sub.subscriptionStatus === STATUS.EXPIRED || !sub.hasPaidAccess) {
      return res.status(403).json({
        error: 'Sua assinatura expirou. Renove para continuar.',
        code: 'SUBSCRIPTION_EXPIRED',
      });
    }
    const plan = sub.plan;
    if (minPlan === 'VIP' && plan !== 'VIP') {
      return res.status(403).json({
        error: 'Recurso exclusivo do plano VIP',
        code: 'VIP_REQUIRED',
      });
    }
    if (!sub.isPremium) {
      return res.status(403).json({
        error: 'Recurso disponível apenas para assinantes Premium',
        code: 'PREMIUM_REQUIRED',
      });
    }
    next();
  };
}

/**
 * Migração automática de usuários existentes (idempotente).
 */
/**
 * Repara contas admin degradadas para role=premium pela migração antiga.
 */
async function repairDegradedPrivilegedUsers(db) {
  const adminEmails = privilegedAdminEmails();
  if (!adminEmails.size) return { repaired: 0 };
  const users = await db.listUsers(10_000);
  let repaired = 0;
  for (const u of users) {
    const email = String(u.email || '').toLowerCase();
    if (!adminEmails.has(email)) continue;
    if (isAdminUser(u)) continue;
    await db.updateUser(u.id, { role: 'master', active: true, blocked: false });
    log.warn('conta admin reparada (role restaurada para master)', { email, previousRole: u.role });
    repaired++;
  }
  return { repaired };
}

/**
 * Varredura de expiração — downgrade automático de assinaturas vencidas.
 * ---------------------------------------------------------------------
 * Roda no boot e periodicamente (worker). Para todo usuário pago cujo
 * `expiresAt` já passou e que ainda NÃO está marcado como expirado:
 *   - subscriptionStatus = 'expired'  (corta hasPaidAccess/isPremium)
 *   - role 'premium' → 'user'         (defesa extra; preserva admin/owner/master)
 *
 * O campo `plan` é preservado (modelo "lapsed") para permitir renovação
 * mensal sem perder o histórico do tier. O acesso efetivo cai para FREE
 * imediatamente, pois todo gate (REST + socket) consulta o status/expiração.
 *
 * Idempotente: usuários já 'expired' são ignorados. Admins nunca são tocados.
 *
 * @param {object} [opts]
 * @param {function} [opts.onExpire]  callback(userId, user) por usuário rebaixado
 * @returns {Promise<{ expired: number, scanned: number }>}
 */
async function expireSubscriptions(db, opts = {}) {
  const onExpire = typeof opts.onExpire === 'function' ? opts.onExpire : null;
  const now = Date.now();
  let users;
  try {
    users = await db.listUsers(50_000);
  } catch (err) {
    log.warn('expireSubscriptions: listUsers falhou', { err: err.message });
    return { expired: 0, scanned: 0 };
  }
  let expired = 0;
  for (const u of users) {
    if (isAdminUser(u) || isPrivilegedAdminEmail(u?.email)) continue;
    const plan = normalizePlan(u.plan);
    if (!isPaidPlan(plan)) continue;
    if (!u.expiresAt) continue; // sem data → tratado pela migração; não expira aqui
    const exp = new Date(u.expiresAt).getTime();
    if (!Number.isFinite(exp) || exp >= now) continue; // ainda válido
    if (String(u.subscriptionStatus || '').toLowerCase() === STATUS.EXPIRED) continue; // já expirado
    if (u.blocked === true) continue; // bloqueado tem fluxo próprio

    const patch = { subscriptionStatus: STATUS.EXPIRED };
    // Reseta role degradado 'premium' → 'user' (NUNCA toca admin/owner/master).
    if (String(u.role || '').toLowerCase() === 'premium') patch.role = 'user';
    try {
      await db.updateUser(u.id, patch);
      expired++;
      log.info('assinatura expirada — acesso Premium revogado automaticamente', {
        userId: u.id, email: u.email, plan, expiresAt: u.expiresAt,
      });
      if (onExpire) {
        try { onExpire(u.id, u); } catch (_) { /* notificação não-crítica */ }
      }
    } catch (err) {
      const missingCol = err?.code === '42703' || /column.*does not exist/i.test(String(err?.message || ''));
      if (missingCol) {
        log.warn('expireSubscriptions: colunas de assinatura ausentes — rode a migração 004', { err: err.message });
        break;
      }
      log.warn('expireSubscriptions: updateUser falhou', { userId: u.id, err: err.message });
    }
  }
  if (expired > 0) {
    log.info('varredura de expiração concluída', { expired, scanned: users.length });
  }
  return { expired, scanned: users.length };
}

async function migrateExistingUsers(db) {
  const users = await db.listUsers(10_000);
  let updated = 0;
  for (const u of users) {
    const patch = {};
    const plan = normalizePlan(u.plan);
    const wasBlocked = u.active === false;

    if (u.blocked == null && wasBlocked) patch.blocked = true;
    if (u.blocked == null && !wasBlocked) patch.blocked = false;
    if (!u.subscriptionStatus) {
      if (patch.blocked || u.blocked) patch.subscriptionStatus = STATUS.BLOCKED;
      else patch.subscriptionStatus = STATUS.ACTIVE;
    }
    if (isPaidPlan(plan) && !u.expiresAt) {
      const days = durationDaysForPlan(plan);
      patch.expiresAt = addDays(u.createdAt || new Date(), days).toISOString();
      patch.subscriptionStatus = STATUS.ACTIVE;
      // NUNCA alterar role de contas privilegiadas; clientes pagos → premium.
      if (!isAdminUser(u) && String(u.role || 'user').toLowerCase() === 'user') {
        patch.role = 'premium';
      }
    }
    if (isPaidPlan(plan) && u.expiresAt) {
      const exp = new Date(u.expiresAt).getTime();
      if (Number.isFinite(exp) && exp < Date.now() && !patch.blocked && !u.blocked && !wasBlocked) {
        patch.subscriptionStatus = STATUS.EXPIRED;
      }
    }
    if (Object.keys(patch).length) {
      await db.updateUser(u.id, patch);
      updated++;
    }
  }
  const { repaired } = await repairDegradedPrivilegedUsers(db);
  if (updated || repaired) {
    log.info('migração de assinaturas aplicada', { updated, repaired, total: users.length });
  }
  return { updated, repaired, total: users.length };
}

module.exports = {
  STATUS,
  PLAN_DURATION_DAYS,
  PAID_PLANS,
  normalizePlan,
  isAdminUser,
  isPaidPlan,
  addDays,
  durationDaysForPlan,
  resolveSubscriptionState,
  syncSubscriptionStatus,
  activateSubscription,
  blockUser,
  unblockUser,
  renewSubscription,
  expireSubscriptions,
  logAdminAction,
  enrichUserForClient,
  attachSubscription,
  requireNotBlocked,
  requireActiveSubscription,
  requirePaidPlan,
  migrateExistingUsers,
  repairDegradedPrivilegedUsers,
  resolveSubscriptionRole,
  privilegedAdminEmails,
  isPrivilegedAdminEmail,
  DEFAULT_BOOTSTRAP_EMAIL,
  PRIVILEGED_ROLES,
};
