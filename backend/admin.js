/**
 * Robotrend IA — Rotas Admin (multi-tenant SaaS)
 *
 *  - Overview (KPIs gerais)
 *  - CRUD de usuários (CREATE / READ / UPDATE / DELETE / reset senha)
 *  - Pagamentos
 *  - Sinais (visão global do admin)
 */

'use strict';

const auth = require('./auth');
const { logger } = require('./logger');
const log = logger.child({ module: 'admin' });

const VALID_PLANS = ['FREE', 'VIP', 'PREMIUM'];
const VALID_ROLES = ['user', 'premium', 'admin'];

function safeUser(u) {
  if (!u) return null;
  const { passwordHash, resetToken, resetTokenExpires, ...safe } = u;
  return safe;
}

function buildAdminRoutes(app, db, requireAuth, requireAdmin) {
  // todas as rotas /api/admin/* exigem auth + admin
  app.use('/api/admin', requireAuth(db), requireAdmin);

  /* ============================================================
     OVERVIEW
     ============================================================ */
  app.get('/api/admin/overview', async (req, res) => {
    try {
      const overview = await db.adminOverview();
      const stats = await db.getStats(); // global stats
      res.json({ ...overview, signalsStats: stats });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /* ============================================================
     USERS — LIST
     ============================================================ */
  app.get('/api/admin/users', async (req, res) => {
    try {
      const limit = Number(req.query.limit || 100);
      const users = await db.listUsers(limit);
      res.json({ users: users.map(safeUser) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /* ============================================================
     USERS — CREATE (admin cria novo cliente)
     POST /api/admin/users
     Body: { email, password, name?, role?, plan? }
     ============================================================ */
  app.post('/api/admin/users', async (req, res) => {
    try {
      // Trim defensivo em todos os campos
      const body = req.body || {};
      const emailRaw    = String(body.email    ?? '').trim();
      const password    = String(body.password ?? '').trim();
      const name        = String(body.name     ?? '').trim();
      const role        = body.role;
      const plan        = body.plan;

      if (!emailRaw || !password) {
        return res.status(400).json({ error: 'EMAIL_PASSWORD_REQUIRED' });
      }
      if (password.length < 6) {
        return res.status(400).json({ error: 'PASSWORD_TOO_SHORT' });
      }
      const normalizedEmail = emailRaw.toLowerCase();
      const existing = await db.findUserByEmail(normalizedEmail);
      if (existing) {
        return res.status(409).json({ error: 'EMAIL_ALREADY_EXISTS' });
      }

      const finalRole = VALID_ROLES.includes(role) ? role : 'user';
      const finalPlan = VALID_PLANS.includes(plan) ? plan : 'FREE';
      const passwordHash = await auth.hashPassword(password);

      const user = await db.createUser({
        email: normalizedEmail,
        name: name ? name.slice(0, 60) : normalizedEmail.split('@')[0],
        passwordHash,
        plan: finalPlan,
        role: finalRole,
      });

      log.info('admin criou usuário', {
        adminId: req.user.id,
        adminEmail: req.user.email,
        newUserId: user.id,
        newUserEmail: user.email,
        role: finalRole,
        plan: finalPlan,
      });

      res.status(201).json({ ok: true, user: safeUser(user) });
    } catch (e) {
      log.error('admin createUser falhou', { err: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  /* ============================================================
     USERS — UPDATE (role / plan / name)
     ============================================================ */
  app.patch('/api/admin/users/:id', async (req, res) => {
    try {
      const body = req.body || {};
      const plan = body.plan;
      const role = body.role;
      const nameRaw = String(body.name ?? '').trim();
      const patch = {};
      if (VALID_PLANS.includes(plan)) patch.plan = plan;
      if (VALID_ROLES.includes(role)) patch.role = role;
      if (nameRaw) patch.name = nameRaw.slice(0, 60);

      // Segurança: impede self-demote
      if (role && role !== 'admin' && req.user.id === req.params.id) {
        return res.status(400).json({ error: 'você não pode remover seu próprio role admin' });
      }

      const user = await db.updateUser(req.params.id, patch);
      if (!user) return res.status(404).json({ error: 'usuário não encontrado' });

      log.info('admin atualizou usuário', {
        adminId: req.user.id,
        targetId: req.params.id,
        patch,
      });

      res.json({ ok: true, user: safeUser(user) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /* ============================================================
     USERS — RESET PASSWORD (admin define nova senha p/ um cliente)
     POST /api/admin/users/:id/password
     Body: { password }
     ============================================================ */
  app.post('/api/admin/users/:id/password', async (req, res) => {
    try {
      const password = String((req.body || {}).password ?? '').trim();
      if (!password || password.length < 6) {
        return res.status(400).json({ error: 'PASSWORD_TOO_SHORT' });
      }
      const target = await db.findUserById(req.params.id);
      if (!target) return res.status(404).json({ error: 'usuário não encontrado' });

      const passwordHash = await auth.hashPassword(password);
      await db.updateUser(req.params.id, {
        passwordHash,
        resetToken: null,
        resetTokenExpires: null,
      });

      log.warn('admin alterou senha de usuário', {
        adminId: req.user.id,
        targetId: req.params.id,
        targetEmail: target.email,
      });

      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /* ============================================================
     USERS — DELETE (remove cliente)
     DELETE /api/admin/users/:id
     ============================================================ */
  app.delete('/api/admin/users/:id', async (req, res) => {
    try {
      if (req.user.id === req.params.id) {
        return res.status(400).json({ error: 'você não pode remover sua própria conta' });
      }
      const target = await db.findUserById(req.params.id);
      if (!target) return res.status(404).json({ error: 'usuário não encontrado' });

      if (typeof db.deleteUser === 'function') {
        await db.deleteUser(req.params.id);
      } else {
        // Fallback: marca o user como "removed" sem deletar (preserva histórico)
        await db.updateUser(req.params.id, {
          email: `removed_${Date.now()}_${target.email}`,
          role: 'user',
          plan: 'FREE',
        });
      }

      log.warn('admin removeu usuário', {
        adminId: req.user.id,
        targetId: req.params.id,
        targetEmail: target.email,
      });

      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /* ============================================================
     PAYMENTS
     ============================================================ */
  app.get('/api/admin/payments', async (req, res) => {
    try {
      const limit = Number(req.query.limit || 100);
      const payments = await db.listPayments(limit);
      res.json({ payments });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /* ============================================================
     SIGNALS — visão global (admin vê todos)
     ============================================================ */
  app.get('/api/admin/signals', async (req, res) => {
    try {
      const limit = Number(req.query.limit || 100);
      const signals = await db.listSignals(limit); // sem userId = global
      res.json({ signals });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { buildAdminRoutes };
