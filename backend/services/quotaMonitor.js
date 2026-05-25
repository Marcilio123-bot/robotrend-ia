/**
 * Robotrend IA — Quota Monitor
 *
 * Job periódico que emite o snapshot da quota da API-Sports no event bus
 * (`quota` para dashboards, `quota:low` quando entra na zona crítica).
 *
 * Também persiste o uso diário em log (linha por dia em logs/quota.log)
 * para análise histórica.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const apiFootball = require('./footballProvider');
const events = require('./footballEvents');
const { getJobs } = require('./jobs');
const { logger } = require('../logger');

const log = logger.child({ module: 'quotaMonitor' });

const INTERVAL_MS = Number(process.env.QUOTA_MONITOR_INTERVAL_MS || 30_000);
const LOG_FILE    = path.join(__dirname, '..', '..', 'logs', 'quota.log');

let lastDayLogged = null;

function appendDailyLog(snapshot) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    if (lastDayLogged === day) return;
    lastDayLogged = day;
    const line = JSON.stringify({
      day,
      ts: new Date().toISOString(),
      dailyLimit: snapshot.dailyLimit,
      dailyRemaining: snapshot.dailyRemaining,
      minuteLimit: snapshot.minuteLimit,
      minuteRemaining: snapshot.minuteRemaining,
    }) + '\n';
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFile(LOG_FILE, line, () => {});
  } catch (e) { /* best effort */ }
}

const LOW_PCT = Number(process.env.API_FOOTBALL_QUOTA_LOW_PCT || 0.20);

function tick() {
  const q = apiFootball.quota();
  const safe = apiFootball.safeMode ? apiFootball.safeMode() : { active: false };
  events.emit('quota', { quota: q, safeMode: safe });
  // Sofascore não tem headers de quota — skipa o log diário com nulls.
  if (q.dailyLimit != null) appendDailyLog(q);
  if (q.dailyLimit && q.dailyRemaining != null) {
    const pct = q.dailyRemaining / q.dailyLimit;
    if (pct <= LOW_PCT) {
      events.emit('quota:low', { remaining: q.dailyRemaining, limit: q.dailyLimit, ratio: pct });
    }
  }
}

function start() {
  const jobs = getJobs();
  jobs.every('quotaMonitor', INTERVAL_MS, tick, { runOnStart: false });
  // primeiro tick após 5s, dando tempo do poller iniciar e popular headers
  setTimeout(tick, 5_000);
  log.info('quota monitor ativo', { intervalMs: INTERVAL_MS });
}

function stop() {
  try { getJobs().cancel('quotaMonitor'); } catch {}
}

function snapshot() {
  return {
    intervalMs: INTERVAL_MS,
    lowThreshold: LOW_PCT,
    quota: apiFootball.quota(),
    breaker: apiFootball.breaker?.snapshot?.() || null,
    safeMode: apiFootball.safeMode ? apiFootball.safeMode() : null,
  };
}

module.exports = { start, stop, snapshot };
