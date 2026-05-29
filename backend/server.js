/**
 * Robotrend IA — Servidor v5.0.0 Production
 *
 *  Adições produção:
 *    - logger estruturado + httpMiddleware
 *    - metrics endpoint
 *    - compression gzip opcional (sem dep nativa)
 *    - cleanup job de sinais antigos
 *    - quality report endpoint
 *    - funnel snapshot endpoint
 *    - readiness/liveness probes (/healthz, /readyz)
 *    - graceful shutdown
 */

'use strict';

const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const envPath = path.join(__dirname, '..', '.env');
// override:false — variáveis do Render/host têm prioridade sobre .env local
if (fs.existsSync(envPath)) require('dotenv').config({ path: envPath, override: false });

const {
  APP_VERSION,
  assertProductionEnv,
  buildCorsOptions,
  buildSocketCors,
  resolvePublicBaseUrl,
  isOnRender,
  parseAllowedOrigins,
} = require('./startup-check');
const {
  printConnectivityReport,
  probeOptionalDns,
} = require('./startup-connectivity');
assertProductionEnv();

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server: SocketIOServer } = require('socket.io');

const db = require('./database');
const { RobotrendBot } = require('./bot');
const { sendSignal } = require('./telegram');
const auth = require('./auth');
const { applySecurity } = require('./security');
const { requireFeature } = require('./plans');
const { buildAuthRoutes } = require('./auth');
const bruteforce = require('./bruteforce');
const { buildPaymentRoutes } = require('./payments');
const { buildAdminRoutes } = require('./admin');
const { buildFootballRoutes } = require('./routes/football');
const footballHistory = require('./services/footballHistory');
const footballAlerts = require('./services/footballAlerts');
const signalsEngine = require('./services/signalsEngine');
const betSignalEngine = require('./services/betSignalEngine');
const quotaMonitor = require('./services/quotaMonitor');
const { attachFootballRealtime } = require('./services/footballRealtime');
const { getPoller } = require('./workers/liveFootballPoller');
const { getEnricher } = require('./services/fixtureEnricher');
const { logger, httpMiddleware } = require('./logger');
const metrics = require('./metrics');
const quality = require('./quality');
const onboarding = require('./onboarding');
const { bootstrapMasterAdmin: bootstrapMaster, resetMasterAdmin } = require('./services/bootstrapAdmin');
const backtest = require('./backtest');
const results = require('./results');
const beta = require('./beta');
const watchdog = require('./watchdog');
const ml = require('./ml');

const log = logger.child({ module: 'server' });

const PORT = Number(process.env.PORT || 3010);
const app = express();

/* ============================================================
   COMPRESSION (sem deps externas — usa zlib nativo)
   ============================================================ */
app.use((req, res, next) => {
  const accept = req.headers['accept-encoding'] || '';
  const shouldCompress = accept.includes('gzip') && req.url.startsWith('/api/');
  if (!shouldCompress) return next();

  const origJson = res.json.bind(res);
  res.json = function (body) {
    try {
      const buf = Buffer.from(JSON.stringify(body), 'utf8');
      if (buf.length < 1024) return origJson(body);
      const gz = zlib.gzipSync(buf);
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Length', gz.length);
      res.end(gz);
    } catch (e) {
      origJson(body);
    }
  };
  next();
});

applySecurity(app);
app.use(cors(buildCorsOptions()));
app.use(express.json({ limit: '1mb' }));
app.use(httpMiddleware);
app.use(metrics.httpMetricsMiddleware);

const frontendDir = path.join(__dirname, '..', 'frontend');

/** Rotas HTML legadas → páginas canônicas (evita 404 no menu antigo). */
const HTML_PAGE_ALIASES = {
  'painel-estatisticas.html': 'quality.html',
  'painel-resultados.html': 'results.html',
  'painel-admin.html': 'admin.html',
  'estatisticas.html': 'quality.html',
  'stats.html': 'quality.html',
  'perfil.html': 'index.html',
};
for (const [legacy, target] of Object.entries(HTML_PAGE_ALIASES)) {
  app.get(`/${legacy}`, (req, res) => res.redirect(301, `/${target}`));
}

/**
 * URLs limpas das páginas MASTER (sem extensão .html no sidebar).
 * Cada rota serve um HTML DIFERENTE — sem hash, sem reuso de página.
 */
const ADMIN_CLEAN_ROUTES = {
  '/admin':            'admin.html',
  '/admin/users':      'admin-users.html',
  '/admin/finance':    'admin-finance.html',
  '/admin/system':     'admin-system.html',
  '/admin/backtest':   'admin-backtest.html',
  '/admin/ops':        'admin-football.html',
  '/ops/live':         'admin-football.html',
  '/admin/live':       'admin-football.html',
};
for (const [route, file] of Object.entries(ADMIN_CLEAN_ROUTES)) {
  app.get([route, route + '.html'], (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.sendFile(path.join(__dirname, '..', 'frontend', file));
  });
}

/**
 * ROTAS HTML EXPLÍCITAS (garantia anti-fallback)
 * --------------------------------------------------
 * Em vez de depender só do `express.static`, registramos cada página real
 * com `sendFile` + `Cache-Control: no-store`. Isso garante que:
 *   - cada URL serve o arquivo correto, sem ambiguidade
 *   - browsers e proxies NUNCA cacheiam HTML antigo
 *   - se algum middleware tentar interceptar com fallback, perde a corrida
 *     para o handler explícito (que vem antes do static)
 */
const PUBLIC_PAGES = [
  'index.html', 'login.html', 'register.html', 'forgot.html', 'reset.html',
  'pricing.html', 'signals.html', 'analytics.html', 'football.html',
  'results.html', 'quality.html', 'backtest.html',
  'admin.html', 'admin-football.html', 'admin-ops.html',
  'admin-users.html', 'admin-finance.html', 'admin-system.html', 'admin-backtest.html',
  'account.html',
];

function sendHtmlNoStore(res, file) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(frontendDir, file));
}

for (const page of PUBLIC_PAGES) {
  app.get(`/${page}`, (req, res) => sendHtmlNoStore(res, page));
}
// Root → index
app.get('/', (req, res) => sendHtmlNoStore(res, 'index.html'));

app.use(express.static(frontendDir, {
  index: false, // o handler explícito de "/" já cuida disso
  setHeaders: (res, p) => {
    if (p.endsWith('service-worker.js')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (p.endsWith('.html')) {
      // Safety net: se algum HTML escapar das rotas explícitas, ainda assim no-store
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    } else if (p.endsWith('output.css') || p.endsWith('style.css')) {
      // Tailwind build + style do projeto — cache curto (1h) controlado pelo SW
      res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
    }
  },
}));

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: buildSocketCors(),
  perMessageDeflate: true,
  // Render termina TLS na borda; cliente usa wss:// — polling como fallback
  transports: ['websocket', 'polling'],
  pingTimeout: 25_000,
  pingInterval: 10_000,
});
const bot = new RobotrendBot(io);

/* ============================================================
   PROBES
   ============================================================ */
app.get('/healthz', (req, res) => res.status(200).send('ok'));
app.get('/readyz', async (req, res) => {
  try {
    if (db.isPostgres()) await db.listUsers(1);
    res.status(200).send('ready');
  } catch (e) {
    res.status(503).send('not-ready');
  }
});

app.get('/api/health', (req, res) => {
  const af = require('./services/footballProvider');
  const afSt = af.status?.() || {};
  res.json({
    ok: true,
    service: 'Robotrend IA',
    version: APP_VERSION,
    edition: 'SaaS · Bet365 · Production',
    demo: String(process.env.DEMO_MODE || 'true') === 'true',
    telegram: String(process.env.TELEGRAM_ENABLED || 'false') === 'true',
    postgres: db.isPostgres(),
    render: isOnRender(),
    publicUrl: resolvePublicBaseUrl() || null,
    corsOrigins: parseAllowedOrigins().length,
    football: {
      configured: af.isConfigured?.() ?? false,
      activeProvider: afSt.activeProvider || af.providerName,
      priority: af.priority,
    },
    uptime: process.uptime(),
    pid: process.pid,
  });
});

/**
 * /api/metrics
 *   - requireAuth + requireAdmin (padrão)
 *   - bypass opcional via header "X-Metrics-Token" === process.env.METRICS_TOKEN
 *     (para Prometheus scrape ou Render/Railway internal monitor)
 */
function metricsAuth(req, res, next) {
  const token = req.headers['x-metrics-token'];
  const expected = process.env.METRICS_TOKEN;
  if (expected && token && token === expected) return next();
  return auth.requireAuth(db)(req, res, (err) => {
    if (err) return next(err);
    return auth.requireAdmin(req, res, next);
  });
}

app.get('/api/metrics', metricsAuth, (req, res) => {
  const snap = metrics.snapshot();
  snap.bot = bot.snapshot();
  res.json(snap);
});

app.get('/api/matches', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  const snap = await bot.forceRefresh();
  res.json(snap);
});

/* ============================================================
   SYSTEM TOGGLES (LIVE / PRELIVE)
   ============================================================ */
app.get('/api/system/status', (req, res) => {
  res.json(bot.systemStatus());
});

app.post('/api/live/toggle', auth.requireSystemToggle(db), (req, res) => {
  const desired = req.body && typeof req.body.enabled === 'boolean' ? req.body.enabled : !bot.liveEnabled;
  const r = bot.setLiveEnabled(desired);
  res.json({ ok: true, ...r, status: bot.systemStatus() });
});

app.post('/api/prelive/toggle', auth.requireSystemToggle(db), (req, res) => {
  const desired = req.body && typeof req.body.enabled === 'boolean' ? req.body.enabled : !bot.preliveEnabled;
  const r = bot.setPreliveEnabled(desired);
  res.json({ ok: true, ...r, status: bot.systemStatus() });
});

/* ============================================================
   AUTH
   ============================================================ */
buildAuthRoutes(app, db);

/* ============================================================
   DEV-ONLY — endpoints de socorro para destravar login local
   ------------------------------------------------------------
   Habilitados APENAS quando NODE_ENV !== production/staging.
   Em deploy a rota responde 404 (rota não existe).
   ============================================================ */
{
  const env = process.env.NODE_ENV || 'development';
  const devEnabled = env !== 'production' && env !== 'staging';
  if (devEnabled) {
    console.log('[AUTH LOGIN] DEV ENDPOINTS ATIVOS — GET /api/dev/reset-admin disponível (env=' + env + ')');

    app.get('/api/dev/reset-admin', async (req, res) => {
      try {
        const customEmail = req.query.email ? String(req.query.email) : undefined;
        const customPass = req.query.password ? String(req.query.password) : undefined;
        const info = await resetAdminUser({ email: customEmail, password: customPass });
        // Também limpa TODOS os locks de bruteforce — útil quando o IP local
        // ficou bloqueado por testes anteriores com email errado.
        const clearedAll = bruteforce.resetAll();
        console.log(`[AUTH LOGIN] /api/dev/reset-admin OK → ${info.email} · bruteforce.resetAll: ${clearedAll}`);
        res.json({
          ok: true,
          admin: {
            email: info.email,
            password: customPass || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'admin123',
            role: info.role,
            plan: info.plan,
          },
          bruteforceCleared: clearedAll,
          hint: 'Faça POST /api/auth/login com { email, password } acima.',
        });
      } catch (err) {
        console.error('[AUTH LOGIN] /api/dev/reset-admin ERRO:', err.message);
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    // Bônus: limpar apenas o bruteforce sem mexer no admin (caso já saiba a senha)
    app.get('/api/dev/clear-bruteforce', (req, res) => {
      const cleared = bruteforce.resetAll();
      console.log(`[AUTH LOGIN] /api/dev/clear-bruteforce → removidas ${cleared} entradas`);
      res.json({ ok: true, cleared });
    });
  }
}

/* ============================================================
   PAYMENTS
   ============================================================ */
buildPaymentRoutes(app, db, auth.requireAuth);

/* ============================================================
   PROTECTED (planos)
   ============================================================ */
app.get('/api/prelive',
  auth.requireAuth(db),
  requireFeature('prelive'),
  async (req, res) => {
    try {
      const list = await bot.runPrelive();
      res.json({ fixtures: list });
    } catch (err) { res.status(500).json({ error: err.message }); }
  }
);

/**
 * /api/signals — histórico de sinais
 *  - admin     → vê todos os sinais do sistema (sem filtro)
 *  - premium   → vê histórico completo (até o limite do plano)
 *  - user/free → vê histórico limitado pelo plano (PLAN_FREE_DAILY_SIGNALS, etc)
 *
 * Sinais ao vivo são produto compartilhado (gerados pelo betSignalEngine),
 * mas o HISTÓRICO retornado respeita o plano do usuário.
 */
app.get('/api/signals',
  auth.requireAuth(db),
  async (req, res) => {
    const role = String(req.user.role || '').toLowerCase();
    const plan = String(req.user.plan || 'FREE').toUpperCase();
    const isAdmin = role === 'admin' || role === 'owner';

    // Limites por plano
    let cap;
    if (isAdmin)              cap = 1000;
    else if (plan === 'PREMIUM') cap = 500;
    else if (plan === 'VIP')     cap = 200;
    else                          cap = 30; // FREE

    const requested = Number(req.query.limit || 50);
    const limit = Math.min(requested, cap);

    const signals = await db.listSignals(limit, null);
    res.json({
      signals,
      meta: { limit, cap, plan, isAdmin },
    });
  }
);

/**
 * /api/stats — estatísticas
 *  - admin     → stats globais do sistema
 *  - user/etc  → stats globais (produto é compartilhado), mas a UI pode mostrar
 *                "performance do robô" como confiança de marca
 */
app.get('/api/stats',
  auth.requireAuth(db),
  async (req, res) => {
    const s = await db.getStats(); // global stats
    res.json({
      ...s,
      currentMinScore: bot.snapshot().minScore,
      // expõe info do plano do user para UI ajustar UX
      user: { plan: req.user.plan, role: req.user.role },
    });
  }
);

/**
 * /api/me/stats — stats individuais do usuário logado (resultados que ele marcou)
 * Multi-tenant real: cada user vê apenas suas próprias apostas registradas.
 */
app.get('/api/me/stats',
  auth.requireAuth(db),
  async (req, res) => {
    try {
      const s = await db.getStats(req.user.id);
      res.json({ ...s, scope: 'user', userId: req.user.id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * /api/me/signals — histórico de sinais que o user marcou como apostados
 */
app.get('/api/me/signals',
  auth.requireAuth(db),
  async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit || 50), 200);
      const signals = await db.listSignals(limit, req.user.id);
      res.json({ signals, scope: 'user' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * /api/me/subscription — informações do plano atual do usuário logado.
 *
 * Retorna:
 *   {
 *     plan:          'FREE' | 'PREMIUM' | 'VIP' | ...
 *     role:          'user' | 'premium' | 'admin'
 *     isPremium:     bool
 *     subscription:  { status, expiresAt, provider, ... } | null
 *     paymentHistory: [ ...últimos 10 pagamentos ]
 *     features:      lista de features liberadas pelo plano
 *   }
 *
 * Usado pela página /account.html ("Minha Assinatura").
 */
app.get('/api/me/subscription',
  auth.requireAuth(db),
  async (req, res) => {
    try {
      const user = req.user;
      const fresh = await db.findUserById(user.id);
      const planDef = require('./plans').getPlan(fresh?.plan || 'FREE');

      let subscription = null;
      let paymentHistory = [];
      try {
        const allPayments = await db.listPayments(200);
        const mine = (allPayments || []).filter(p =>
          String(p.user_id || p.userId) === String(user.id)
        );
        paymentHistory = mine.slice(0, 10).map(p => ({
          id: p.id,
          provider: p.provider,
          amount: p.amount_brl ?? p.amount,
          plan: p.plan,
          status: p.status,
          createdAt: p.created_at || p.createdAt,
        }));
        const lastPaid = mine.find(p => p.status === 'paid' || p.status === 'active' || p.status === 'trialing');
        if (lastPaid) {
          subscription = {
            status: lastPaid.status,
            provider: lastPaid.provider,
            plan: lastPaid.plan,
            startedAt: lastPaid.created_at || lastPaid.createdAt,
            externalId: lastPaid.external_id || lastPaid.externalId,
          };
        }
      } catch (err) {
        log.warn('me/subscription: listPayments falhou', { err: err.message });
      }

      const role = String(fresh?.role || 'user').toLowerCase();
      const planUp = String(fresh?.plan || 'FREE').toUpperCase();
      const isAdmin = role === 'admin' || role === 'owner';
      const isPremium = isAdmin || role === 'premium'
        || planUp === 'PREMIUM' || planUp === 'VIP' || planUp === 'PRO' || planUp === 'TRIAL';

      // `access` é a fonte canônica de "o que o user pode fazer" — toda UI
      // deve checar `access.bestSignal`, `access.realtimeSignals`, etc.
      const access = {
        // Frontend gates
        bestSignal:         isPremium,
        realtimeSignals:    isPremium,    // sinais sem delay
        fullSignalAnalysis: isPremium,    // premiumInsight + betScore visíveis
        signalFilters:      isPremium,    // confidence >= 75
        // Backend features (gating real, requireFeature)
        prelive:        !!planDef.features.prelive,
        over25:         !!planDef.features.over25,
        telegramAlerts: !!planDef.features.telegramAlerts,
        api:            !!planDef.features.api,
        // Admin
        admin:    isAdmin,
        analytics: true,
      };

      res.json({
        user: {
          id: fresh.id, email: fresh.email, name: fresh.name,
          plan: fresh.plan, role: fresh.role,
          createdAt: fresh.created_at || fresh.createdAt,
        },
        plan: planDef.id,
        planLabel: planDef.label,
        planPriceBRL: planDef.priceBRL,
        role: fresh.role,
        isPremium,
        isAdmin,
        access,
        subscription,
        paymentHistory,
        features: planDef.features,
        dailySignalsLimit: planDef.dailySignals,
        serverTime: new Date().toISOString(),
      });
    } catch (err) {
      log.error('me/subscription error', { err: err.message });
      res.status(500).json({ error: err.message });
    }
  }
);

app.post('/api/signals/test',
  auth.requireAuth(db),
  auth.requireAdmin,
  async (req, res) => {
    const demo = {
      matchId: 'test-1', home: 'Flamengo', away: 'Vasco',
      league: 'Brasileirão Série A', minute: 72,
      market: 'Escanteios', verdict: '🔥 PRESSÃO FORTE DETECTADA',
      suggestion: 'Over 10.5 Escanteios', asianLine: 'Linha asiática: 10.25',
      confidence: 91, pressure: 88, intensity: 82,
      classification: { level: 'HOT', emoji: '🔥', label: 'PRESSÃO MÁXIMA' },
      risk: { level: 'LOW', emoji: '🟢', label: 'BAIXO' }, odd: 1.15,
      momentum: { score: 74, label: 'SUBINDO' },
      snapshot: { corners: 9, dangerousAttacks: 78, shots: 17, shotsOnTarget: 6, possession: 58, score: { home: 1, away: 0 } },
      createdAt: new Date().toISOString(),
    };
    const tg = await sendSignal(demo);
    io.emit('signal:new', { ...demo, telegram: tg });
    metrics.recordSignal();
    res.json({ ok: true, telegram: tg, signal: demo });
  }
);

app.post('/api/signals/:id/result',
  auth.requireAuth(db),
  auth.requireAdmin,
  async (req, res) => {
    const { result } = req.body || {};
    if (!['win', 'loss'].includes(result)) return res.status(400).json({ error: 'result deve ser "win" ou "loss"' });
    await db.recordResult(req.params.id, result);
    const stats = await db.getStats();
    io.emit('stats:update', stats);
    res.json({ ok: true, stats });
  }
);

/* ============================================================
   QUALITY + FUNNEL
   ============================================================ */
app.get('/api/quality',
  auth.requireAuth(db),
  async (req, res) => {
    res.json(await quality.buildReport(db));
  }
);

app.get('/api/admin/funnel',
  auth.requireAuth(db), auth.requireAdmin,
  (req, res) => res.json(onboarding.funnelSnapshot())
);

/* ============================================================
   BACKTEST (admin)
   ============================================================ */
app.post('/api/backtest/run',
  auth.requireAuth(db), auth.requireAdmin,
  (req, res) => {
    const matches = Array.isArray(req.body?.matches) && req.body.matches.length
      ? req.body.matches
      : backtest.buildSyntheticDataset(Number(req.body?.synthetic || 200));
    const report = backtest.runBacktest(matches, {
      minScore: Number(req.body?.minScore || 80),
      stake: Number(req.body?.stake || 1),
    });
    res.json(report);
  }
);

app.get('/api/backtest/synthetic',
  auth.requireAuth(db), auth.requireAdmin,
  (req, res) => res.json({ matches: backtest.buildSyntheticDataset(Number(req.query.n || 100)) })
);

/* ============================================================
   RESULTS (lucro, ROI, streaks, heatmap)
   ============================================================ */
app.get('/api/results',
  auth.requireAuth(db),
  async (req, res) => res.json(await results.summary())
);

/* ============================================================
   BETA (coupons + feedback)
   Sistema de cadastro é aberto — convites foram REMOVIDOS.
   ============================================================ */
app.post('/api/beta/coupons', auth.requireAuth(db), auth.requireAdmin, (req, res) => {
  res.json(beta.createCoupon(req.body || {}));
});
app.get('/api/beta/coupons', auth.requireAuth(db), auth.requireAdmin, (req, res) => {
  res.json({ coupons: beta.listCoupons() });
});

// usuário aplica cupom
app.post('/api/beta/coupons/apply', (req, res) => {
  const body = req.body || {};
  const code = String(body.code ?? '').trim().toUpperCase();
  const plan = String(body.plan ?? '').trim().toUpperCase();
  const basePrice = Number(body.basePrice);
  if (!code || !plan || !basePrice) return res.status(400).json({ ok: false, error: 'parâmetros faltando' });
  res.json(beta.applyCoupon(code, plan, basePrice));
});

// feedback (qualquer user logado pode enviar; anônimo permitido)
app.post('/api/beta/feedback', async (req, res) => {
  const token = auth.extractToken(req);
  let userId = null, email = null;
  if (token) {
    const p = auth.verifyToken(token);
    if (p?.sub) { const u = await db.findUserById(p.sub); if (u) { userId = u.id; email = u.email; } }
  }
  const fb = beta.addFeedback({
    userId, email,
    rating: req.body?.rating, text: req.body?.text, page: req.body?.page,
  });
  res.json({ ok: true, feedback: fb });
});

app.get('/api/beta/feedback',
  auth.requireAuth(db), auth.requireAdmin,
  (req, res) => res.json({ feedback: beta.listFeedback(500), stats: beta.feedbackStats() })
);

/* ============================================================
   FOOTBALL API (API-Sports)
   ============================================================ */
buildFootballRoutes(app, auth.requireAuth, db, auth.requireAdmin, io);

/* ============================================================
   ADMIN
   ============================================================ */
buildAdminRoutes(app, db, auth.requireAuth, auth.requireAdmin);

/* ============================================================
   /api/admin/ops — central operacional (Operacional IA)
   ------------------------------------------------------------
   Aggrega health + bot + poller + processo num único payload
   consumido pelo widget frontend/admin/ops-status.js.
   ============================================================ */
app.get('/api/admin/ops', async (req, res) => {
  try {
    const af = require('./services/footballProvider');
    const afSt = af.status?.() || {};
    const poller = getPoller();
    const psnap = poller?.snapshot?.() || {};
    const bsnap = bot?.snapshot?.() || {};
    const mem = process.memoryUsage();
    const sigStats = await db.getStats().catch(() => ({}));
    const lastErrors = [];

    if (psnap.lastError) {
      lastErrors.push({
        source: 'poller',
        message: typeof psnap.lastError === 'string'
          ? psnap.lastError
          : (psnap.lastError.message || JSON.stringify(psnap.lastError)),
        at: psnap.lastTickAt || null,
      });
    }
    if (psnap.lastFallbackReason) {
      lastErrors.push({
        source: 'poller-fallback',
        message: `fallback: ${psnap.lastFallbackReason}`,
        at: psnap.lastTickAt || null,
      });
    }

    res.json({
      ok: true,
      football: {
        configured: af.isConfigured?.() ?? false,
        activeProvider: afSt.activeProvider || af.providerName,
        priority: af.priority || [],
        safeMode: af.isSafeMode?.() || false,
      },
      poller: {
        running: psnap.running,
        alive: psnap.alive,
        health: psnap.health,
        intervalMs: psnap.intervalMs,
        lastTickAt: psnap.lastTickAt,
        lastTickMs: psnap.stats?.lastDurationMs ?? null,
        tracked: psnap.tracked,
        consecutiveFailures: psnap.consecutiveFailures,
        lastFallbackReason: psnap.lastFallbackReason,
        ticksSuccess: psnap.stats?.ticksSuccess ?? 0,
        ticksFailed: psnap.stats?.ticksFailed ?? 0,
      },
      bot: {
        liveEnabled: bsnap.liveEnabled,
        preliveEnabled: bsnap.preliveEnabled,
        monitored: (bsnap.matches || []).length,
        minScore: bsnap.minScore,
      },
      signals: {
        sent:    sigStats?.sent    ?? 0,
        wins:    sigStats?.wins    ?? 0,
        losses:  sigStats?.losses  ?? 0,
        winrate: sigStats?.winrate ?? 0,
        roi:     sigStats?.roi     ?? 0,
      },
      process: {
        uptime: process.uptime(),
        pid: process.pid,
        memory: {
          rss: mem.rss,
          heapUsed: mem.heapUsed,
          heapTotal: mem.heapTotal,
          external: mem.external,
        },
      },
      errors: lastErrors,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ============================================================
   /api/admin/match-debug — snapshot do pipeline LIVE
   ------------------------------------------------------------
   Devolve, por estágio, quantos matches entraram, quantos saíram
   e por quê. Útil para responder em segundos "por que provider
   retornou N e o dashboard só mostra M?".
   Estágios:
     - poller.filters  (blacklist liga, priority, status live)
     - live.tick       (freshness + consensus)
     - bot.runOnce     (checkFn + pre-emit)
   ============================================================ */
app.get('/api/admin/match-debug', async (req, res) => {
  try {
    const af = require('./services/footballProvider');
    const poller = getPoller();
    const pollerSnap = poller?.getLastDebugSnapshot?.() || null;
    let scannerSnap = null;
    try { scannerSnap = bot?.live?.getLastDebugSnapshot?.() || null; } catch (_) {}
    const botSnap = bot?.getLastDebugSnapshot?.() || null;

    res.json({
      ok: true,
      provider: {
        active: af.providerName || null,
        priority: af.priority || [],
        configured: af.isConfigured?.() ?? false,
      },
      env: {
        STRICT_REAL_ONLY: String(process.env.STRICT_REAL_ONLY || ''),
        MATCH_CONSENSUS_MODE: String(process.env.MATCH_CONSENSUS_MODE || '(default)'),
        MATCH_DEBUG: String(process.env.MATCH_DEBUG || 'true'),
        LIVE_IMPORTANT_LEAGUES_ONLY: String(process.env.LIVE_IMPORTANT_LEAGUES_ONLY || 'false'),
      },
      stages: {
        poller: pollerSnap,
        liveTick: scannerSnap,
        bot: botSnap,
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ============================================================
   404 explícito para .html inexistentes
   --------------------------------------------------
   IMPORTANTE: NÃO há catch-all aqui (nada de app.get('*', ...)).
   Cada HTML real é servido pelo handler explícito acima OU pelo
   express.static. Se chegar aqui é porque o arquivo NÃO existe.
   Apenas .html legados ainda fazem redirect (HTML_PAGE_ALIASES).
   Qualquer outra .html desconhecida retorna 404 limpo —
   nunca masquerar como index.html.
   ============================================================ */
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io')) return next();
  if (!req.path.endsWith('.html')) return next();

  const filePath = path.join(frontendDir, req.path.replace(/^\//, ''));
  if (fs.existsSync(filePath)) {
    return sendHtmlNoStore(res, req.path.replace(/^\//, ''));
  }
  log.warn('html 404', { from: req.path });
  return res.status(404).type('html').send(`<!doctype html><meta charset="utf-8">
<title>404 — Página não encontrada</title>
<style>body{font-family:system-ui;display:grid;place-items:center;min-height:100vh;background:#07100a;color:#e6f4ec;margin:0}.box{text-align:center;padding:24px}.box h1{font-size:48px;margin:0 0 8px}.box a{color:#14b85e}</style>
<div class="box"><h1>404</h1><p>A página <code>${req.path}</code> não existe.</p><p><a href="/index.html">Voltar ao dashboard →</a></p></div>`);
});

/* ============================================================
   SOCKET.IO — auth opcional + metrics
   ============================================================ */
io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token
    || socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '');
  if (token) {
    const payload = auth.verifyToken(token);
    if (payload?.sub) {
      const u = await db.findUserById(payload.sub);
      if (u) socket.user = { id: u.id, plan: u.plan, role: u.role, email: u.email };
    }
  }
  next();
});

io.on('connection', async (socket) => {
  metrics.recordWsConnect(socket.user);
  log.info('ws connected', { id: socket.id, user: socket.user?.email || 'anon' });
  socket.emit('hello', { service: 'Robotrend IA', socketId: socket.id, user: socket.user || null });

  const snap = bot.snapshot();
  socket.emit('system:status', bot.systemStatus());
  socket.emit('matches:update', snap.matches);
  socket.emit('analyses:update', snap.analyses);
  socket.emit('stats:update', await db.getStats());
  socket.emit('signals:list', await db.listSignals(20));

  socket.on('disconnect', () => {
    metrics.recordWsDisconnect(socket.user);
    log.info('ws disconnected', { id: socket.id });
  });
});

/* ============================================================
   USER REALTIME — emite eventos para um userId específico
   ------------------------------------------------------------
   Usado pelo webhook do Mercado Pago após aprovar pagamento.
   Itera os sockets conectados e emite o evento APENAS para os
   sockets cujo `socket.user.id` bate com o userId alvo.

   Caso o user esteja com várias abas abertas, todas recebem.
   Caso o user esteja offline no momento, o frontend faz refresh
   automático no próximo connect (auth-guard chama /auth/me).
   ============================================================ */
function emitToUser(userId, event, payload) {
  if (!userId) return 0;
  const target = String(userId);
  let count = 0;
  try {
    for (const [, sock] of io.of('/').sockets) {
      if (sock.user && String(sock.user.id) === target) {
        sock.emit(event, payload);
        count++;
      }
    }
    // Também emite no /football namespace (caso o user esteja em página com /football)
    try {
      for (const [, sock] of io.of('/football').sockets) {
        if (sock.user && String(sock.user.id) === target) {
          sock.emit(event, payload);
          count++;
        }
      }
    } catch (_) { /* namespace pode não existir ainda */ }
  } catch (err) {
    log.warn('emitToUser falhou', { userId, event, err: err.message });
  }
  return count;
}

// Expõe para outros módulos (payments.js, etc) acessarem
app.locals.emitToUser = emitToUser;

/* ============================================================
   BOOTSTRAP
   ============================================================ */
async function bootstrapAdmin() {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!email || !password) return;
  const exists = await db.findUserByEmail(email.toLowerCase());
  if (exists) return;
  const passwordHash = await auth.hashPassword(password);
  await db.createUser({
    email: email.toLowerCase(), name: 'Admin', passwordHash,
    role: 'admin', plan: 'PREMIUM',
  });
  log.info('bootstrap admin criado', { email });
}

/**
 * Reset agressivo do admin local — usado pelo endpoint /api/dev/reset-admin.
 * Cria o usuário se não existir, sobrescreve a senha com bcrypt(admin123),
 * promove para role=admin/plan=PREMIUM e limpa o lock de bruteforce.
 *
 * Idempotente: pode ser chamado quantas vezes for preciso para destravar
 * o painel durante desenvolvimento.
 */
async function resetAdminUser({ email, password } = {}) {
  const targetEmail = (email || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@robotrend.local').toLowerCase();
  const targetPassword = password || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'admin123';
  const passwordHash = await auth.hashPassword(targetPassword);
  const existing = await db.findUserByEmail(targetEmail);
  let user;
  if (existing) {
    user = await db.updateUser(existing.id, {
      passwordHash,
      role: 'admin',
      plan: 'PREMIUM',
      resetToken: null,
      resetTokenExpires: null,
    });
    console.log(`[AUTH LOGIN] resetAdminUser → atualizado email="${targetEmail}" id=${existing.id}`);
  } else {
    user = await db.createUser({
      email: targetEmail,
      name: 'Admin',
      passwordHash,
      role: 'admin',
      plan: 'PREMIUM',
    });
    console.log(`[AUTH LOGIN] resetAdminUser → criado email="${targetEmail}" id=${user.id}`);
  }
  // Limpa qualquer lock de bruteforce associado a esse email
  const cleared = bruteforce.reset(targetEmail);
  if (cleared) console.log(`[AUTH LOGIN] resetAdminUser → bruteforce limpo (${cleared} entradas removidas)`);
  return { email: targetEmail, id: user.id, role: user.role, plan: user.plan, bruteforceCleared: cleared };
}

/* ============================================================
   PERIODIC JOBS
   ============================================================ */
async function startCleanupJob() {
  const run = async () => {
    try {
      const purged = await db.cleanupOldSignals(90);
      if (purged) log.info('cleanup signals', { purged });
    } catch (e) { log.error('cleanup error', { err: e.message }); }
  };
  setInterval(run, 6 * 3600 * 1000); // a cada 6h
  setTimeout(run, 60 * 1000);        // primeira execução 1min após boot
}

async function startAdaptiveLoop() {
  const tune = async () => {
    try {
      const report = await quality.buildReport(db);
      ml.applyAdaptiveWeights(report.weights, report.marketMinScore);
      log.info('adaptive weights atualizados', {
        leagues: Object.keys(report.weights.leagues || {}).length,
        hours: Object.keys(report.weights.hours || {}).length,
        markets: Object.keys(report.marketMinScore || {}).length,
      });
    } catch (e) { log.error('adaptive loop error', { err: e.message }); }
  };
  setInterval(tune, 30 * 60 * 1000); // a cada 30 min
  setTimeout(tune, 2 * 60 * 1000);   // primeira execução 2min após boot (dá tempo de DB encher)
}

/* ============================================================
   START + GRACEFUL SHUTDOWN
   ============================================================ */
async function main() {
  const bootReport = printConnectivityReport();

  try {
    await db.init();
  } catch (e) {
    log.fatal('PostgreSQL falhou no boot — causa provável: DATABASE_URL ausente ou PGHOST=postgres (ENOTFOUND)', {
      err: e.message,
      code: e.code,
    });
    throw e;
  }

  // Master admin (idempotente — cria se não existir, promove se role < master,
  // reseta senha se BOOTSTRAP_ADMIN_FORCE_RESET=true).
  try {
    await bootstrapMaster(db);
  } catch (e) {
    log.error('[AUTH] bootstrap master falhou', { err: e.message });
  }
  // Legacy bootstrapAdmin (mantido p/ compat — sem-op se já existe)
  await bootstrapAdmin();

  /* ============================================================
     FOOTBALL SaaS STACK
     1. History (PG migrations + memory fallback)
     2. Live poller (single owner — chama API e fan-out via EventBus)
     3. Realtime (Socket.io namespace /football + rooms)
     4. Alerts engine (Telegram via thresholds em eventos do bus)
     5. Quota monitor (publica `quota` periodicamente)
     ============================================================ */
  try { await footballHistory.init(); }
  catch (e) { log.warn('footballHistory init falhou', { err: e.message }); }

  const af = require('./services/footballProvider');
  const afStatus = af.status();
  log.info('Football providers boot', {
    configured: af.isConfigured(),
    activeProvider: afStatus.activeProvider || af.providerName,
    priority: af.priority,
    apisportsKey: process.env.API_FOOTBALL_KEY ? 'set' : 'MISSING',
    oddsOptional: !process.env.ODDS_API_KEY || String(process.env.ODDS_OPTIONAL || '').toLowerCase() === 'true',
  });
  if (!af.isConfigured()) {
    log.warn('Nenhum provider live configurado — modo degradado (poller heartbeat, scanner vazio)');
  } else if (!process.env.API_FOOTBALL_KEY) {
    log.info('API_FOOTBALL_KEY ausente — usando failover: ' + (af.priority || []).join(' → '));
  }

  try { attachFootballRealtime(io, { db, auth }); }
  catch (e) { log.warn('footballRealtime init falhou (modo degradado)', { err: e.message }); }

  try { footballAlerts.start(); } catch (e) { log.warn('footballAlerts start falhou', { err: e.message }); }
  try { signalsEngine.start(); } catch (e) { log.warn('signalsEngine start falhou', { err: e.message }); }
  try { betSignalEngine.start(); } catch (e) { log.warn('betSignalEngine start falhou', { err: e.message }); }
  try { quotaMonitor.start(); } catch (e) { log.warn('quotaMonitor start falhou', { err: e.message }); }

  const footballPoller = getPoller();
  const enricher = getEnricher();
  enricher.setPoller(footballPoller);
  try { enricher.start(); } catch (e) { log.warn('fixtureEnricher start falhou', { err: e.message }); }

  if (String(process.env.FOOTBALL_POLLER_ENABLED || 'true').toLowerCase() !== 'false') {
    try { footballPoller.start(); }
    catch (e) { log.warn('football poller start falhou (heartbeat tentará continuar)', { err: e.message }); }
  } else {
    log.warn('football poller desabilitado (FOOTBALL_POLLER_ENABLED=false)');
  }

  try { bot.start(); } catch (e) { log.warn('bot start falhou', { err: e.message }); }
  startCleanupJob();
  startAdaptiveLoop();
  try { watchdog.start(); } catch (e) { log.warn('watchdog start falhou', { err: e.message }); }

  probeOptionalDns(bootReport).catch((e) => {
    log.warn('DNS probe pós-boot falhou (não fatal)', { err: e.message });
  });

  const publicBase = resolvePublicBaseUrl();
  server.listen(PORT, () => {
    log.info('Robotrend IA online', { port: PORT, version: APP_VERSION, publicUrl: publicBase || 'local' });
    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`🤖  ROBOTREND IA v${APP_VERSION} — COMMERCIAL READY`);
    if (publicBase) {
      console.log(`🌐  Painel:    ${publicBase}/`);
      console.log(`🔐  Login:     ${publicBase}/login.html`);
      console.log(`⚽  Football:  ${publicBase}/football.html`);
      console.log(`💚  Healthz:   ${publicBase}/healthz`);
      console.log(`📡  WSS:       ${publicBase.replace(/^http/, 'ws')}/socket.io/`);
    } else {
      console.log(`🌐  Painel:    http://localhost:${PORT}`);
      console.log(`🔐  Login:     http://localhost:${PORT}/login.html`);
      console.log(`💎  Pricing:   http://localhost:${PORT}/pricing.html`);
      console.log(`👑  Admin:     http://localhost:${PORT}/admin.html`);
      console.log(`📈  Quality:   http://localhost:${PORT}/quality.html`);
      console.log(`💰  Results:   http://localhost:${PORT}/results.html`);
      console.log(`🧪  Backtest:  http://localhost:${PORT}/backtest.html`);
      console.log(`📊  Metrics:   http://localhost:${PORT}/api/metrics`);
      console.log(`💚  Healthz:   http://localhost:${PORT}/healthz`);
    }
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');
  });
}

function shutdown(signal) {
  log.warn(`signal received: ${signal} - graceful shutdown`);
  try { getPoller().stop(); } catch {}
  try { getEnricher().stop(); } catch {}
  try { footballAlerts.stop(); } catch {}
  try { signalsEngine.stop(); } catch {}
  try { betSignalEngine.stop(); } catch {}
  try { quotaMonitor.stop(); } catch {}
  bot.stop();
  io.close();
  server.close(() => {
    log.info('server closed');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
['SIGINT','SIGTERM'].forEach((sig) => process.on(sig, () => shutdown(sig)));

process.on('unhandledRejection', (err) => {
  const msg = err?.message || String(err);
  const code = err?.code || '';
  if (/ENOTFOUND|getaddrinfo|EAI_AGAIN/i.test(msg) || code === 'ENOTFOUND') {
    log.error('unhandledRejection (rede/DNS — verifique DATABASE_URL, API_FOOTBALL_HOST, REDIS_URL)', {
      err: msg,
      code,
    });
    return;
  }
  log.error('unhandledRejection', { err: msg, code });
});
process.on('uncaughtException',  (err) => log.fatal('uncaughtException',  { err: err?.message || String(err) }));

main().catch((err) => {
  const code = err?.code || err?.cause?.code || '';
  const hint = /ENOTFOUND|getaddrinfo/i.test(err?.message || '')
    ? ' → Verifique DATABASE_URL no Render (não use PGHOST=postgres). Relatório [STARTUP CONNECTIVITY] acima.'
    : '';
  log.fatal('startup failed' + hint, { err: err.message, code });
  process.exit(1);
});
