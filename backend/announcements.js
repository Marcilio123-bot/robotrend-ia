/**
 * Robotrend IA — Avisos / Comunicados
 *
 *  - Admin (painel Master) cria/edita/remove comunicados:
 *      GET    /api/master/announcements         (lista todos)
 *      POST   /api/master/announcements         (cria)
 *      PATCH  /api/master/announcements/:id      (edita título/mensagem/ativo)
 *      DELETE /api/master/announcements/:id      (remove)
 *
 *  - Usuários recebem os avisos ATIVOS ao entrar no sistema:
 *      GET    /api/announcements                 (somente active=true, público)
 *
 *  Obs.: as rotas /api/master/* já são protegidas por requireAuth+requireAdmin
 *  no buildMasterRoutes; aqui registramos as rotas de aviso explicitamente
 *  com os mesmos middlewares para manter o módulo independente.
 */

'use strict';

const { logger } = require('./logger');
const log = logger.child({ module: 'announcements' });

const MAX_TITLE = 120;
const MAX_MESSAGE = 2000;

function sanitizeText(v, max) {
  return String(v ?? '').trim().slice(0, max);
}

function buildAnnouncementRoutes(app, db, requireAuth, requireAdmin) {
  /* ============================================================
     PÚBLICO — avisos ativos exibidos a todos os usuários
     ============================================================ */
  app.get('/api/announcements', async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const announcements = await db.listAnnouncements({ activeOnly: true, limit: 20 });
      res.json({ ok: true, announcements });
    } catch (e) {
      log.warn('listar avisos ativos falhou', { err: e.message });
      res.status(500).json({ ok: false, error: e.message, announcements: [] });
    }
  });

  /* ============================================================
     ADMIN — CRUD de avisos (painel Master)
     ============================================================ */
  app.get('/api/master/announcements',
    requireAuth(db), requireAdmin,
    async (req, res) => {
      try {
        const announcements = await db.listAnnouncements({ activeOnly: false, limit: 200 });
        res.json({ ok: true, announcements });
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
      }
    }
  );

  app.post('/api/master/announcements',
    requireAuth(db), requireAdmin,
    async (req, res) => {
      try {
        const body = req.body || {};
        const title = sanitizeText(body.title, MAX_TITLE);
        const message = sanitizeText(body.message, MAX_MESSAGE);
        if (!title || !message) {
          return res.status(400).json({ ok: false, error: 'TITLE_MESSAGE_REQUIRED' });
        }
        const active = typeof body.active === 'boolean' ? body.active : true;
        const announcement = await db.createAnnouncement({ title, message, active });
        log.info('aviso criado', { adminId: req.user.id, id: announcement.id, active });
        res.status(201).json({ ok: true, announcement });
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
      }
    }
  );

  app.patch('/api/master/announcements/:id',
    requireAuth(db), requireAdmin,
    async (req, res) => {
      try {
        const body = req.body || {};
        const patch = {};
        if (typeof body.title === 'string') patch.title = sanitizeText(body.title, MAX_TITLE);
        if (typeof body.message === 'string') patch.message = sanitizeText(body.message, MAX_MESSAGE);
        if (typeof body.active === 'boolean') patch.active = body.active;
        if (patch.title === '' || patch.message === '') {
          return res.status(400).json({ ok: false, error: 'TITLE_MESSAGE_REQUIRED' });
        }
        const announcement = await db.updateAnnouncement(req.params.id, patch);
        if (!announcement) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
        log.info('aviso atualizado', { adminId: req.user.id, id: announcement.id, patch });
        res.json({ ok: true, announcement });
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
      }
    }
  );

  app.delete('/api/master/announcements/:id',
    requireAuth(db), requireAdmin,
    async (req, res) => {
      try {
        const removed = await db.deleteAnnouncement(req.params.id);
        if (!removed) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
        log.warn('aviso removido', { adminId: req.user.id, id: req.params.id });
        res.json({ ok: true });
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
      }
    }
  );
}

module.exports = { buildAnnouncementRoutes };
