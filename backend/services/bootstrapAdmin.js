/**
 * Robotrend IA — Bootstrap Master Admin
 * ============================================================
 *
 * Garante que SEMPRE exista um usuário master no PostgreSQL no boot.
 *
 * Fluxo:
 *   1. Lê BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD.
 *      Se não definidas → usa defaults seguros (somente em dev/staging).
 *   2. Procura o usuário no banco (PG ou memory store).
 *   3. Se NÃO existir → cria com bcrypt hash + role='master' + plan='PREMIUM'.
 *   4. Se existir mas BOOTSTRAP_ADMIN_FORCE_RESET=true → reseta senha + role.
 *   5. Se existir mas a role atual NÃO é master/admin → promove para master.
 *
 * Idempotente: rodar várias vezes não duplica nem corrompe nada.
 *
 * Logs:
 *   [AUTH] master admin criado (email=…, role=master)
 *   [AUTH] master admin atualizado (force reset)
 *   [AUTH] master admin promovido (role anterior → master)
 *   [AUTH] master admin OK (já existe, sem alterações)
 */

'use strict';

const auth = require('../auth');
const { isProductionLike } = require('../startup-check');

/**
 * Defaults — usados SOMENTE se as ENVs não estiverem definidas.
 * Em produção, sempre forneça BOOTSTRAP_ADMIN_* via Render Environment.
 */
const DEFAULT_EMAIL    = 'admin@robotrend.local';
const DEFAULT_PASSWORD = 'marciliosantos548675';

/** Roles consideradas "master-level" — não rebaixar se já for uma delas. */
const MASTER_ROLES = new Set(['master', 'admin', 'owner', 'super_admin']);

function resolveCredentials() {
  const email    = String(process.env.BOOTSTRAP_ADMIN_EMAIL    || DEFAULT_EMAIL).trim().toLowerCase();
  const password = String(process.env.BOOTSTRAP_ADMIN_PASSWORD || DEFAULT_PASSWORD).trim();
  const usingDefaults = !process.env.BOOTSTRAP_ADMIN_EMAIL || !process.env.BOOTSTRAP_ADMIN_PASSWORD;
  return { email, password, usingDefaults };
}

function isForceReset() {
  return String(process.env.BOOTSTRAP_ADMIN_FORCE_RESET || 'false').toLowerCase() === 'true';
}

/**
 * Bootstrap principal — chamado no `main()` do server.js logo após `db.init()`.
 *
 * @param {object} db   - camada de banco (PG ou memory)
 * @returns {Promise<{ email, id, role, action }>}
 *   action ∈ 'created' | 'reset' | 'promoted' | 'unchanged'
 */
async function bootstrapMasterAdmin(db) {
  const { email, password, usingDefaults } = resolveCredentials();
  const forceReset = isForceReset();

  if (usingDefaults && isProductionLike()) {
    console.warn(
      '[AUTH] BOOTSTRAP_ADMIN_EMAIL/PASSWORD ausentes em produção — ' +
      'usando defaults. Configure no Render Environment ASAP.'
    );
  }

  let user;
  try {
    user = await db.findUserByEmail(email);
  } catch (e) {
    console.error('[AUTH] bootstrap falhou ao consultar DB:', e.message);
    throw e;
  }

  // 1) Não existe → cria
  if (!user) {
    const passwordHash = await auth.hashPassword(password);
    const created = await db.createUser({
      email,
      name: 'Master Admin',
      passwordHash,
      role: 'master',
      plan: 'PREMIUM',
    });
    console.log(`[AUTH] master admin criado (email=${email}, role=master, plan=PREMIUM, id=${created.id})`);
    return { email, id: created.id, role: 'master', action: 'created' };
  }

  // 2) Existe + force reset solicitado → atualiza senha + role
  if (forceReset) {
    const passwordHash = await auth.hashPassword(password);
    const updated = await db.updateUser(user.id, {
      passwordHash,
      role: 'master',
      plan: 'PREMIUM',
      resetToken: null,
      resetTokenExpires: null,
    });
    console.log(`[AUTH] master admin atualizado (force reset · email=${email}, id=${user.id})`);
    return { email, id: updated.id, role: 'master', action: 'reset' };
  }

  // 3) Existe mas role não é master/admin → promove
  const currentRole = String(user.role || 'user').toLowerCase();
  if (!MASTER_ROLES.has(currentRole)) {
    const updated = await db.updateUser(user.id, {
      role: 'master',
      plan: 'PREMIUM',
    });
    console.log(`[AUTH] master admin promovido (role ${currentRole} → master · email=${email}, id=${user.id})`);
    return { email, id: updated.id, role: 'master', action: 'promoted' };
  }

  // 4) Tudo OK — apenas confirma
  console.log(`[AUTH] master admin OK (email=${email}, role=${currentRole}, id=${user.id})`);
  return { email, id: user.id, role: currentRole, action: 'unchanged' };
}

/**
 * Reset forçado on-demand — usado pelos endpoints /api/dev/reset-admin
 * e por scripts CLI. Aceita override de email/senha.
 */
async function resetMasterAdmin(db, { email, password } = {}) {
  const fallback = resolveCredentials();
  const targetEmail    = (email    || fallback.email).toLowerCase();
  const targetPassword = (password || fallback.password);
  const passwordHash   = await auth.hashPassword(targetPassword);

  const existing = await db.findUserByEmail(targetEmail);
  if (existing) {
    const updated = await db.updateUser(existing.id, {
      passwordHash,
      role: 'master',
      plan: 'PREMIUM',
      resetToken: null,
      resetTokenExpires: null,
    });
    console.log(`[AUTH] resetMasterAdmin → atualizado email="${targetEmail}" id=${existing.id}`);
    return { email: targetEmail, id: updated.id, action: 'reset' };
  }
  const created = await db.createUser({
    email: targetEmail,
    name: 'Master Admin',
    passwordHash,
    role: 'master',
    plan: 'PREMIUM',
  });
  console.log(`[AUTH] resetMasterAdmin → criado email="${targetEmail}" id=${created.id}`);
  return { email: targetEmail, id: created.id, action: 'created' };
}

module.exports = {
  bootstrapMasterAdmin,
  resetMasterAdmin,
  resolveCredentials,
  MASTER_ROLES,
};
