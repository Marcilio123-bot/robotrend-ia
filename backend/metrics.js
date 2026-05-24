/**
 * Robotrend IA — Métricas / Observabilidade
 *
 *   - CPU / RAM / heap
 *   - WS conexões / usuários online
 *   - HTTP request rate + latência (rolling)
 *   - Tempo de resposta médio
 *   - Snapshot exposto em /api/metrics e /api/health (rico)
 */

'use strict';

const os = require('os');

const state = {
  startedAt: Date.now(),
  ws: { connected: 0, total: 0, anonymous: 0, byPlan: {} },
  users: { online: new Set() },
  http: { count: 0, errors: 0, lastDurations: [] },
  signals: { sentSession: 0 },
};

function recordWsConnect(user) {
  state.ws.connected++;
  state.ws.total++;
  if (!user) state.ws.anonymous++;
  if (user?.plan) state.ws.byPlan[user.plan] = (state.ws.byPlan[user.plan] || 0) + 1;
  if (user?.id) state.users.online.add(user.id);
}

function recordWsDisconnect(user) {
  state.ws.connected = Math.max(0, state.ws.connected - 1);
  if (user?.id) {
    // Pode haver multiplas conexões do mesmo usuário; só removemos se zerar.
    // Aproximação simples: removemos sempre, o set é recalculado no recordWsConnect.
    state.users.online.delete(user.id);
  }
}

function recordHttp(durationMs, statusCode) {
  state.http.count++;
  if (statusCode >= 500) state.http.errors++;
  state.http.lastDurations.push(durationMs);
  if (state.http.lastDurations.length > 200) state.http.lastDurations.shift();
}

function recordSignal() { state.signals.sentSession++; }

function avgLatency() {
  const a = state.http.lastDurations;
  if (!a.length) return 0;
  return Math.round(a.reduce((s, x) => s + x, 0) / a.length);
}

function p95Latency() {
  const a = state.http.lastDurations.slice().sort((x, y) => x - y);
  if (!a.length) return 0;
  return a[Math.floor(a.length * 0.95)];
}

function snapshot() {
  const mem = process.memoryUsage();
  return {
    uptimeSeconds: Math.round(process.uptime()),
    startedAt: new Date(state.startedAt).toISOString(),
    process: {
      pid: process.pid,
      node: process.version,
      memory: {
        rssMB:      +(mem.rss / 1048576).toFixed(1),
        heapUsedMB: +(mem.heapUsed / 1048576).toFixed(1),
        heapTotalMB:+(mem.heapTotal / 1048576).toFixed(1),
        externalMB: +(mem.external / 1048576).toFixed(1),
      },
      cpu: process.cpuUsage(),
    },
    os: {
      platform: os.platform(),
      cpus: os.cpus().length,
      load1:  os.loadavg()[0],
      load5:  os.loadavg()[1],
      load15: os.loadavg()[2],
      totalMemMB: Math.round(os.totalmem() / 1048576),
      freeMemMB:  Math.round(os.freemem() / 1048576),
    },
    http: {
      requests: state.http.count,
      errors:   state.http.errors,
      avgMs:    avgLatency(),
      p95Ms:    p95Latency(),
    },
    websocket: {
      connected: state.ws.connected,
      anonymous: state.ws.anonymous,
      total:     state.ws.total,
      byPlan:    state.ws.byPlan,
    },
    users: {
      online: state.users.online.size,
    },
    signals: {
      sentSession: state.signals.sentSession,
    },
  };
}

/**
 * Express middleware: registra duração + status code para todas as /api/*
 */
function httpMetricsMiddleware(req, res, next) {
  if (!req.url.startsWith('/api/')) return next();
  const t0 = Date.now();
  res.on('finish', () => recordHttp(Date.now() - t0, res.statusCode));
  next();
}

module.exports = {
  snapshot,
  recordWsConnect,
  recordWsDisconnect,
  recordHttp,
  recordSignal,
  httpMetricsMiddleware,
};
