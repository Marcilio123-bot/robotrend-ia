/**
 * Robotrend IA — Logger estruturado (zero deps)
 *
 *   - Níveis: trace, debug, info, warn, error, fatal
 *   - Output JSON em prod / colorido em dev
 *   - Rotação simples por dia em arquivo (./logs/YYYY-MM-DD.log)
 *   - Context binding (logger.child({ module: 'bot' }))
 */

'use strict';

const fs = require('fs');
const path = require('path');
const util = require('util');
const crypto = require('crypto');

// Lazy load metrics to evitar ciclo no boot (logger é carregado primeiro)
let _metrics = null;
function getMetrics() {
  if (_metrics !== null) return _metrics;
  try { _metrics = require('./services/metrics'); }
  catch { _metrics = false; }
  return _metrics;
}

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const MIN_LEVEL = LEVELS[LEVEL] || 30;

const isProd = process.env.NODE_ENV === 'production';
const COLORS = {
  trace: '\x1b[90m',
  debug: '\x1b[36m',
  info:  '\x1b[32m',
  warn:  '\x1b[33m',
  error: '\x1b[31m',
  fatal: '\x1b[35m',
  reset: '\x1b[0m',
  gray:  '\x1b[90m',
};

let logsDir = null;
let currentDay = null;
let stream = null;

function ensureLogsDir() {
  if (logsDir) return logsDir;
  logsDir = path.join(__dirname, '..', 'logs');
  try { fs.mkdirSync(logsDir, { recursive: true }); } catch (e) {}
  return logsDir;
}

function rotate() {
  const day = new Date().toISOString().slice(0, 10);
  if (day === currentDay && stream) return stream;
  if (stream) try { stream.end(); } catch (e) {}
  currentDay = day;
  const file = path.join(ensureLogsDir(), `${day}.log`);
  try { stream = fs.createWriteStream(file, { flags: 'a' }); }
  catch (e) { stream = null; }
  return stream;
}

function fmtDev(level, msg, ctx) {
  const c = COLORS[level] || '';
  const ts = new Date().toISOString().slice(11, 23);
  const m = COLORS.gray + ts + COLORS.reset + ' ' + c + level.toUpperCase().padEnd(5) + COLORS.reset;
  const ctxStr = ctx && Object.keys(ctx).length
    ? ' ' + COLORS.gray + util.inspect(ctx, { colors: true, depth: 3, compact: true }) + COLORS.reset
    : '';
  return `${m} ${msg}${ctxStr}`;
}

function fmtProd(level, msg, ctx) {
  return JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...(ctx && Object.keys(ctx).length ? { ctx } : {}),
  });
}

function emit(level, msg, ctx) {
  if (LEVELS[level] < MIN_LEVEL) return;
  const line = (isProd ? fmtProd : fmtDev)(level, msg, ctx || {});
  const out = (level === 'error' || level === 'fatal') ? process.stderr : process.stdout;
  out.write(line + '\n');
  const s = rotate();
  if (s) {
    try { s.write(fmtProd(level, msg, ctx || {}) + '\n'); } catch (e) {}
  }
}

function makeLogger(bindings = {}) {
  const api = {};
  for (const lvl of Object.keys(LEVELS)) {
    api[lvl] = (msg, ctx) => emit(lvl, msg, { ...bindings, ...(ctx || {}) });
  }
  api.child = (extra) => makeLogger({ ...bindings, ...extra });
  return api;
}

const root = makeLogger({ app: 'robotrend' });

/**
 * Express middleware: loga cada request (api/*) com tempo + correlation id.
 *
 * Recursos:
 *   - req.id           : UUID/curto correlation id (vem do header X-Request-Id ou gerado)
 *   - X-Request-Id res : devolve o mesmo id no response (debug + tracing)
 *   - req.log          : logger com req.id já bindado (use em handlers para traceability)
 *   - métricas         : http_request_ms (histogram com route+status+method)
 *                        http_requests_total (counter por status)
 */
function httpMiddleware(req, res, next) {
  const t0 = Date.now();
  const incoming = req.headers['x-request-id'];
  const reqId = (typeof incoming === 'string' && incoming.length <= 64 && /^[\w.-]+$/.test(incoming))
    ? incoming
    : crypto.randomBytes(8).toString('hex');
  req.id = reqId;
  res.setHeader('X-Request-Id', reqId);
  req.log = root.child({ reqId });

  res.on('finish', () => {
    if (!req.url.startsWith('/api/')) return;
    const ms = Date.now() - t0;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    // Normaliza route: pega o path sem query e troca IDs por :id (genérico) para baixar cardinalidade
    const route = (req.route && req.baseUrl)
      ? `${req.baseUrl}${req.route.path}`
      : req.url.split('?')[0].replace(/\/\d+/g, '/:id');
    root[level](`${req.method} ${req.url} ${res.statusCode}`, {
      reqId,
      ip: req.ip || req.connection?.remoteAddress,
      ms,
      userId: req.user?.id || null,
      route,
    });
    const m = getMetrics();
    if (m) {
      try {
        m.histogram('http_request_ms').observe(ms, { method: req.method, route, status: String(res.statusCode) });
        m.counter('http_requests_total').inc(1, { method: req.method, status: String(res.statusCode) });
      } catch (_) { /* não bloqueia */ }
    }
  });
  next();
}

module.exports = { logger: root, makeLogger, httpMiddleware, LEVELS };
