/**
 * Robotrend IA — Suporte / Fale Conosco
 *
 *  Chat de suporte simples (atendimento NÃO instantâneo). O usuário
 *  (FREE ou PREMIUM) envia dúvidas/sugestões que ficam armazenadas;
 *  o administrador responde posteriormente pelo painel Master.
 *
 *  USUÁRIO (requireAuth):
 *    GET  /api/support/messages          → minha conversa + nº de respostas não lidas
 *    POST /api/support/messages          → envia uma mensagem (dúvida/sugestão)
 *    POST /api/support/read              → marca as respostas do admin como lidas
 *
 *  ADMIN (requireAuth + requireAdmin):
 *    GET  /api/support/threads           → lista de conversas (1 por usuário)
 *    GET  /api/support/threads/:userId   → conversa completa de um usuário
 *    POST /api/support/threads/:userId/reply → admin responde
 *    GET  /api/support/unread            → total de mensagens não lidas (badge)
 */

'use strict';

const { logger } = require('./logger');
const log = logger.child({ module: 'support' });

const MAX_MESSAGE = 2000;

/** Remove < e > (anti-injection básico) e limita o tamanho. */
function sanitizeText(v, max = MAX_MESSAGE) {
  return String(v ?? '').replace(/[<>]/g, '').trim().slice(0, max);
}

function buildSupportRoutes(app, db, requireAuth, requireAdmin) {
  /* ============================================================
     USUÁRIO — conversa própria
     ============================================================ */
  app.get('/api/support/messages',
    requireAuth(db),
    async (req, res) => {
      try {
        res.setHeader('Cache-Control', 'no-store');
        const messages = await db.listSupportMessages(req.user.id, 200);
        const unread = await db.countSupportUnreadForUser(req.user.id);
        res.json({ ok: true, messages, unread });
      } catch (e) {
        log.warn('listar mensagens do usuário falhou', { err: e.message });
        res.status(500).json({ ok: false, error: e.message, messages: [] });
      }
    }
  );

  app.post('/api/support/messages',
    requireAuth(db),
    async (req, res) => {
      try {
        const body = sanitizeText((req.body || {}).message, MAX_MESSAGE);
        if (!body) {
          return res.status(400).json({ ok: false, error: 'MESSAGE_REQUIRED' });
        }
        const message = await db.createSupportMessage({
          userId: req.user.id,
          userEmail: req.user.email || null,
          userName: req.user.name || null,
          sender: 'user',
          body,
        });
        log.info('mensagem de suporte recebida', { userId: req.user.id, id: message.id });
        res.status(201).json({ ok: true, message });
      } catch (e) {
        log.error('salvar mensagem de suporte falhou', { err: e.message });
        res.status(500).json({ ok: false, error: e.message });
      }
    }
  );

  app.post('/api/support/read',
    requireAuth(db),
    async (req, res) => {
      try {
        await db.markSupportRead(req.user.id, 'user');
        res.json({ ok: true });
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
      }
    }
  );

  /* ============================================================
     ADMIN — gestão das conversas (painel Master)
     ============================================================ */
  app.get('/api/support/unread',
    requireAuth(db), requireAdmin,
    async (req, res) => {
      try {
        res.setHeader('Cache-Control', 'no-store');
        const unread = await db.countSupportUnreadForAdmin();
        res.json({ ok: true, unread });
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message, unread: 0 });
      }
    }
  );

  app.get('/api/support/threads',
    requireAuth(db), requireAdmin,
    async (req, res) => {
      try {
        res.setHeader('Cache-Control', 'no-store');
        const threads = await db.listSupportThreads(300);
        res.json({ ok: true, threads });
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message, threads: [] });
      }
    }
  );

  app.get('/api/support/threads/:userId',
    requireAuth(db), requireAdmin,
    async (req, res) => {
      try {
        res.setHeader('Cache-Control', 'no-store');
        const messages = await db.listSupportMessages(req.params.userId, 500);
        // Abrir a conversa marca as mensagens do usuário como lidas pelo admin.
        await db.markSupportRead(req.params.userId, 'admin');
        res.json({ ok: true, messages });
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message, messages: [] });
      }
    }
  );

  app.post('/api/support/threads/:userId/reply',
    requireAuth(db), requireAdmin,
    async (req, res) => {
      try {
        const body = sanitizeText((req.body || {}).message, MAX_MESSAGE);
        if (!body) {
          return res.status(400).json({ ok: false, error: 'MESSAGE_REQUIRED' });
        }
        const targetId = req.params.userId;
        // Recupera dados do usuário-alvo para carimbar a thread (e-mail/nome).
        let targetUser = null;
        try { targetUser = await db.findUserById(targetId); } catch (_) {}
        const message = await db.createSupportMessage({
          userId: targetId,
          userEmail: targetUser?.email || null,
          userName: targetUser?.name || null,
          sender: 'admin',
          body,
        });

        // Notifica o usuário em tempo real, se estiver conectado.
        try {
          const emitToUser = app.locals.emitToUser;
          if (typeof emitToUser === 'function') {
            emitToUser(targetId, 'support:reply', { message });
          }
        } catch (_) { /* realtime é best-effort */ }

        log.info('admin respondeu suporte', { adminId: req.user.id, targetId, id: message.id });
        res.status(201).json({ ok: true, message });
      } catch (e) {
        log.error('responder suporte falhou', { err: e.message });
        res.status(500).json({ ok: false, error: e.message });
      }
    }
  );
}

module.exports = { buildSupportRoutes };
