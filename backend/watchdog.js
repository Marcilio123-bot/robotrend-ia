/**
 * Robotrend IA — Watchdog
 *
 *   Monitor de processo (sem deps externas).
 *   - Checa heap, RSS, load average
 *   - Checa últimas N latências
 *   - Checa conexões WS
 *   - Dispara alertas via Telegram (se configurado) + console.error
 *   - Suporta self-exit (PM2/Docker reinicia automaticamente)
 */

'use strict';

const os = require('os');
const { logger } = require('./logger');
const metrics = require('./metrics');

let TelegramBot;
try { TelegramBot = require('node-telegram-bot-api'); } catch (e) { TelegramBot = null; }

const log = logger.child({ module: 'watchdog' });

const CFG = {
  intervalMs: Number(process.env.WATCHDOG_INTERVAL_MS || 30_000),
  heapMaxMB:  Number(process.env.WATCHDOG_HEAP_MB || 350),
  rssMaxMB:   Number(process.env.WATCHDOG_RSS_MB  || 500),
  loadMax:    Number(process.env.WATCHDOG_LOAD    || os.cpus().length * 1.5),
  latencyP95: Number(process.env.WATCHDOG_P95_MS  || 1500),
  selfExit:   String(process.env.WATCHDOG_SELF_EXIT || 'true').toLowerCase() === 'true',
};

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT  = process.env.TELEGRAM_ADMIN_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
const TG_ENABLED = String(process.env.TELEGRAM_ENABLED || 'false').toLowerCase() === 'true';
let tgBot = null;
if (TG_ENABLED && TG_TOKEN && TelegramBot) {
  try { tgBot = new TelegramBot(TG_TOKEN, { polling: false }); }
  catch (e) { tgBot = null; }
}

const recentAlerts = new Map();
function shouldThrottle(key, cooldownMs = 10 * 60 * 1000) {
  const last = recentAlerts.get(key) || 0;
  if (Date.now() - last < cooldownMs) return true;
  recentAlerts.set(key, Date.now());
  return false;
}

async function sendAlert(key, text) {
  if (shouldThrottle(key)) return;
  log.warn('ALERT', { key, text });
  console.error(`\x1b[31m⚠️  WATCHDOG ALERT [${key}]\x1b[0m ${text}`);
  if (tgBot && TG_CHAT) {
    try { await tgBot.sendMessage(TG_CHAT, `🚨 *WATCHDOG ROBOTREND*\n${text}`, { parse_mode: 'Markdown' }); }
    catch (e) { log.error('telegram alert fail', { err: e.message }); }
  }
}

function check() {
  const snap = metrics.snapshot();
  const heap = snap.process.memory.heapUsedMB;
  const rss  = snap.process.memory.rssMB;
  const load = snap.os.load1;
  const p95  = snap.http.p95Ms;
  const ws   = snap.websocket.connected;

  if (heap > CFG.heapMaxMB) {
    sendAlert('HEAP_HIGH', `Heap em ${heap}MB (limite ${CFG.heapMaxMB}MB).`);
    if (CFG.selfExit && heap > CFG.heapMaxMB * 1.4) {
      log.fatal('heap critically high, exit for restart', { heap });
      process.exit(137);
    }
  }
  if (rss > CFG.rssMaxMB) {
    sendAlert('RSS_HIGH', `RSS em ${rss}MB (limite ${CFG.rssMaxMB}MB).`);
  }
  if (load > CFG.loadMax) {
    sendAlert('LOAD_HIGH', `Load avg 1m em ${load.toFixed(2)} (limite ${CFG.loadMax}).`);
  }
  if (p95 > CFG.latencyP95) {
    sendAlert('LATENCY_HIGH', `p95 HTTP em ${p95}ms (limite ${CFG.latencyP95}ms).`);
  }
  if (ws === 0 && snap.uptimeSeconds > 60) {
    // só alerta após 60s do boot, e não a cada tick
    sendAlert('WS_NO_CLIENTS', `Sem conexões WebSocket ativas há ${Math.round(snap.uptimeSeconds)}s.`, 30 * 60 * 1000);
  }
}

function start() {
  log.info('watchdog ativo', CFG);
  setInterval(() => {
    try { check(); } catch (e) { log.error('watchdog tick error', { err: e.message }); }
  }, CFG.intervalMs);
}

module.exports = { start, sendAlert };
