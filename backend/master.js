/**
 * Robotrend IA — Painel Master (/master)
 * Gestão profissional de clientes e assinaturas.
 */

'use strict';

const subscription = require('./subscription');
const { logger } = require('./logger');
const youtubeClicks = require('./services/youtubeClicks');
const log = logger.child({ module: 'master' });

const VALID_PLANS = ['FREE', 'VIP', 'PREMIUM'];

function safeUser(u) {
  if (!u) return null;
  const { passwordHash, resetToken, resetTokenExpires, ...rest } = u;
  return subscription.enrichUserForClient(rest);
}

function buildMasterRoutes(app, db, requireAuth, requireAdmin) {
  app.use('/api/master', requireAuth(db), requireAdmin);

  /** GET /api/master/users — listar, pesquisar e filtrar */
  app.get('/api/master/users', async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit || 200), 500);
      const users = await db.listUsers(limit, {
        q: req.query.q,
        plan: req.query.plan,
        status: req.query.status,
      });
      res.json({
        users: users.map(safeUser),
        total: users.length,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /** PATCH /api/master/users/:id — alterar plano / nome */
  app.patch('/api/master/users/:id', async (req, res) => {
    try {
      const body = req.body || {};
      const patch = {};
      if (VALID_PLANS.includes(String(body.plan || '').toUpperCase())) {
        const newPlan = String(body.plan).toUpperCase();
        patch.plan = newPlan;
        const target = await db.findUserById(req.params.id);
        if (target && !subscription.isAdminUser(target)) {
          patch.role = subscription.resolveSubscriptionRole(target.role, newPlan);
        }
      }
      if (body.name) patch.name = String(body.name).trim().slice(0, 60);

      if (req.user.id === req.params.id && patch.role === 'user') {
        return res.status(400).json({ error: 'você não pode remover seu próprio acesso admin' });
      }

      const user = await db.updateUser(req.params.id, patch);
      if (!user) return res.status(404).json({ error: 'usuário não encontrado' });

      await subscription.logAdminAction(db, {
        adminId: req.user.id,
        adminEmail: req.user.email,
        action: 'user.update',
        targetUserId: user.id,
        targetEmail: user.email,
        details: patch,
      });

      res.json({ ok: true, user: safeUser(user) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /** POST /api/master/users/:id/block */
  app.post('/api/master/users/:id/block', async (req, res) => {
    try {
      if (req.user.id === req.params.id) {
        return res.status(400).json({ error: 'você não pode bloquear sua própria conta' });
      }
      const reason = (req.body?.reason || '').trim() || null;
      const user = await subscription.blockUser(db, req.params.id, {
        reason,
        adminId: req.user.id,
        adminEmail: req.user.email,
      });
      if (!user) return res.status(404).json({ error: 'usuário não encontrado' });
      res.json({ ok: true, user: safeUser(user) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /** POST /api/master/users/:id/unblock */
  app.post('/api/master/users/:id/unblock', async (req, res) => {
    try {
      const user = await subscription.unblockUser(db, req.params.id, {
        adminId: req.user.id,
        adminEmail: req.user.email,
      });
      if (!user) return res.status(404).json({ error: 'usuário não encontrado' });
      res.json({ ok: true, user: safeUser(user) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /** POST /api/master/users/:id/renew — Premium +180d, VIP +365d */
  app.post('/api/master/users/:id/renew', async (req, res) => {
    try {
      const plan = req.body?.plan ? String(req.body.plan).toUpperCase() : undefined;
      const user = await subscription.renewSubscription(db, req.params.id, {
        plan,
        adminId: req.user.id,
        adminEmail: req.user.email,
      });
      if (!user) return res.status(404).json({ error: 'usuário não encontrado' });
      res.json({ ok: true, user: safeUser(user) });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  /** DELETE /api/master/users/:id */
  app.delete('/api/master/users/:id', async (req, res) => {
    try {
      if (req.user.id === req.params.id) {
        return res.status(400).json({ error: 'você não pode excluir sua própria conta' });
      }
      const target = await db.findUserById(req.params.id);
      if (!target) return res.status(404).json({ error: 'usuário não encontrado' });

      await db.deleteUser(req.params.id);
      await subscription.logAdminAction(db, {
        adminId: req.user.id,
        adminEmail: req.user.email,
        action: 'user.delete',
        targetUserId: target.id,
        targetEmail: target.email,
        details: {},
      });
      log.warn('master excluiu usuário', { adminId: req.user.id, targetId: target.id });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /** GET /api/master/youtube-clicks — total global (?src=youtube) */
  app.get('/api/master/youtube-clicks', (_req, res) => {
    res.json({ ok: true, total: youtubeClicks.getTotal() });
  });

  /** GET /api/master/logs — auditoria administrativa */
  app.get('/api/master/logs', async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit || 50), 200);
      const logs = await db.listAdminLogs(limit);
      res.json({ logs });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { buildMasterRoutes };
