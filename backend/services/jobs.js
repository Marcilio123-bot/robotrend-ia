/**
 * Robotrend IA — Jobs Abstraction
 *
 * Wrapper genérico para agendar tarefas recorrentes ou pontuais.
 * Dois backends:
 *
 *   - InProcessScheduler   (default — setInterval/setTimeout)
 *   - BullMQScheduler      (opcional — `bullmq` + REDIS_URL)
 *
 * API uniforme:
 *   const jobs = createJobs();
 *   jobs.every(name, ms, fn, { runOnStart })
 *   jobs.once(name, delayMs, fn)
 *   jobs.cancel(name)
 *   jobs.list()
 *
 * Notas:
 *   - Para BullMQ, o `fn` precisa estar registrado também no worker
 *     (`backend/worker.js`). No modo in-process, qualquer função roda
 *     no mesmo processo.
 *   - Trocar de backend é seguro: a API é a mesma.
 */

'use strict';

const { logger } = require('../logger');
const log = logger.child({ module: 'jobs' });

const REDIS_URL = (process.env.REDIS_URL || '').trim();
const USE_BULLMQ = String(process.env.JOBS_BACKEND || 'auto').toLowerCase() === 'bullmq'
  || (String(process.env.JOBS_BACKEND || 'auto').toLowerCase() === 'auto' && !!REDIS_URL);

/* ============================================================
   IN-PROCESS
   ============================================================ */
class InProcessScheduler {
  constructor() {
    this.backend = 'inprocess';
    this.timers = new Map();
    this.recurring = new Map(); // name -> { ms, fn, lastRunAt, runs }
  }

  every(name, ms, fn, opts = {}) {
    this.cancel(name);
    const wrapped = async () => {
      const meta = this.recurring.get(name);
      if (!meta) return;
      meta.lastRunAt = Date.now();
      meta.runs++;
      try { await fn(); }
      catch (e) { log.warn(`recurring job "${name}" falhou`, { err: e.message }); }
    };
    const t = setInterval(wrapped, ms);
    if (typeof t.unref === 'function') t.unref();
    this.timers.set(name, t);
    this.recurring.set(name, { ms, fn, lastRunAt: null, runs: 0 });
    if (opts.runOnStart) setImmediate(wrapped);
  }

  once(name, delayMs, fn) {
    this.cancel(name);
    const t = setTimeout(async () => {
      try { await fn(); }
      catch (e) { log.warn(`one-shot job "${name}" falhou`, { err: e.message }); }
      finally { this.timers.delete(name); }
    }, delayMs);
    if (typeof t.unref === 'function') t.unref();
    this.timers.set(name, t);
  }

  cancel(name) {
    const t = this.timers.get(name);
    if (t) { clearInterval(t); clearTimeout(t); this.timers.delete(name); }
    this.recurring.delete(name);
  }

  list() {
    return Array.from(this.recurring.entries()).map(([name, meta]) => ({
      name, ms: meta.ms, runs: meta.runs, lastRunAt: meta.lastRunAt,
    }));
  }

  info() { return { backend: this.backend, scheduled: this.timers.size }; }
}

/* ============================================================
   BULLMQ (opcional — apenas wrapper, NÃO implementa worker)
   ============================================================ */
class BullMQScheduler {
  constructor() {
    let Queue, Worker;
    try { ({ Queue, Worker } = require('bullmq')); }
    catch (e) {
      const err = new Error('bullmq não instalado — rode `npm i bullmq ioredis`');
      err.code = 'BULLMQ_MISSING';
      throw err;
    }
    if (!REDIS_URL) throw new Error('REDIS_URL ausente — BullMQ exige Redis');
    this.backend = 'bullmq';
    this.queueName = process.env.BULLMQ_QUEUE || 'robotrend';
    this.connection = { url: REDIS_URL };
    this.queue = new Queue(this.queueName, { connection: this.connection });
    this._handlers = new Map();

    // Worker embarcado (executa no mesmo processo).
    // Em produção, considere rodar `node backend/worker.js` em outra máquina.
    this.worker = new Worker(this.queueName, async (job) => {
      const fn = this._handlers.get(job.name);
      if (!fn) throw new Error(`handler não registrado: ${job.name}`);
      return fn(job.data);
    }, { connection: this.connection });

    this.worker.on('failed', (job, err) => log.warn('bullmq job failed', { name: job?.name, err: err.message }));
  }

  /**
   * Agenda recorrente via BullMQ repeat. O `fn` é registrado como handler
   * e disparado pelo worker.
   */
  every(name, ms, fn, opts = {}) {
    this._handlers.set(name, fn);
    this.queue.add(name, opts.data || {}, {
      repeat: { every: ms },
      removeOnComplete: 100,
      removeOnFail: 50,
    });
    if (opts.runOnStart) this.queue.add(name, opts.data || {});
  }

  once(name, delayMs, fn) {
    this._handlers.set(name, fn);
    this.queue.add(name, {}, { delay: delayMs, removeOnComplete: 100, removeOnFail: 50 });
  }

  async cancel(name) {
    try {
      const reps = await this.queue.getRepeatableJobs();
      for (const r of reps) if (r.name === name) await this.queue.removeRepeatableByKey(r.key);
    } catch (e) { log.warn('bullmq cancel falhou', { err: e.message }); }
    this._handlers.delete(name);
  }

  list() {
    return Array.from(this._handlers.keys()).map((name) => ({ name, backend: 'bullmq' }));
  }

  info() {
    return { backend: this.backend, queue: this.queueName, handlers: this._handlers.size };
  }
}

/* ============================================================
   FACTORY
   ============================================================ */
let _singleton = null;

function createJobs() {
  if (USE_BULLMQ) {
    try {
      const j = new BullMQScheduler();
      log.info('jobs: bullmq ativo');
      return j;
    } catch (e) {
      log.warn('jobs: fallback in-process (BullMQ indisponível)', { err: e.message });
    }
  }
  log.info('jobs: in-process scheduler ativo');
  return new InProcessScheduler();
}

function getJobs() {
  if (!_singleton) _singleton = createJobs();
  return _singleton;
}

module.exports = { createJobs, getJobs, InProcessScheduler, BullMQScheduler };
