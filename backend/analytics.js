/**
 * Robotrend IA — Analytics de Usuários
 *
 *  - Registra automaticamente eventos de uso por usuário:
 *      · login            → db.recordLogin (em auth.js)
 *      · último acesso    → touch() throttled (em requireAuth)
 *      · jogos analisados → POST /api/analytics/track { type: 'game_analysis' }
 *      · sinais vistos    → POST /api/analytics/track { type: 'signal_view' }
 *
 *  - Painel admin:
 *      · GET /api/admin/analytics → KPIs + tabela de usuários (filtros)
 */

'use strict';

const { logger } = require('./logger');
const log = logger.child({ module: 'analytics' });

/* ============================================================
   ACTIVITY TOUCH (último acesso) — throttle em memória
   ------------------------------------------------------------
   Atualizar last_seen_at a cada request autenticado seria caro.
   Limitamos a 1 escrita por usuário a cada TOUCH_THROTTLE_MS.
   ============================================================ */
const TOUCH_THROTTLE_MS = Number(process.env.ANALYTICS_TOUCH_THROTTLE_MS || 5 * 60 * 1000);
const lastTouch = new Map(); // userId -> ts

/**
 * Marca o usuário como "visto agora" (fire-and-forget, throttled).
 * Seguro chamar em todo request: só escreve no banco quando expira o throttle.
 */
function touch(db, userId) {
  if (!db || !userId) return;
  const now = Date.now();
  const prev = lastTouch.get(userId) || 0;
  if (now - prev < TOUCH_THROTTLE_MS) return;
  lastTouch.set(userId, now);
  Promise.resolve()
    .then(() => db.touchLastSeen(userId))
    .catch((e) => log.warn('touchLastSeen falhou', { err: e.message }));

  // Higiene: evita que o Map cresça indefinidamente em instâncias longevas.
  if (lastTouch.size > 5000) {
    const cutoff = now - TOUCH_THROTTLE_MS;
    for (const [k, v] of lastTouch) if (v < cutoff) lastTouch.delete(k);
  }
}

/** Mapeia os tipos de evento do cliente para as colunas de contador. */
const EVENT_COLUMN = {
  signal_view: 'signals_viewed_count',
  game_analysis: 'games_analyzed_count',
};

function buildAnalyticsRoutes(app, db, requireAuth, requireAdmin) {
  /* ============================================================
     TRACK — registra eventos de uso do usuário logado
     POST /api/analytics/track
     Body: { type: 'signal_view' | 'game_analysis', count?: number }
     ============================================================ */
  app.post('/api/analytics/track', requireAuth(db), async (req, res) => {
    try {
      const type = String((req.body || {}).type || '').trim();
      const column = EVENT_COLUMN[type];
      if (!column) {
        return res.status(400).json({ ok: false, error: 'INVALID_EVENT_TYPE' });
      }
      // count: nº de itens novos vistos nesta janela (cliente já deduplica).
      const count = Math.max(1, Math.min(100, Number((req.body || {}).count || 1)));
      await db.incrementUserMetric(req.user.id, column, count);
      res.json({ ok: true });
    } catch (e) {
      log.warn('track falhou', { err: e.message });
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /* ============================================================
     ADMIN — painel de analytics de usuários
     GET /api/admin/analytics?filter=&q=&limit=
     ============================================================ */
  app.get('/api/admin/analytics',
    requireAuth(db), requireAdmin,
    async (req, res) => {
      try {
        const filter = String(req.query.filter || '').toLowerCase();
        const q = String(req.query.q || '');
        const limit = Number(req.query.limit || 200);
        const [summary, users] = await Promise.all([
          db.analyticsSummary(),
          db.analyticsUsers({ filter, q, limit }),
        ]);
        res.json({ ok: true, summary, users, filter, generatedAt: new Date().toISOString() });
      } catch (e) {
        log.error('admin analytics falhou', { err: e.message });
        res.status(500).json({ ok: false, error: e.message });
      }
    }
  );
}

module.exports = { buildAnalyticsRoutes, touch };
