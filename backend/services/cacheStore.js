/**
 * Robotrend IA — CacheStore Abstrato
 *
 * Backends suportados:
 *   - MemoryStore (LRU TTL em memória, default)
 *   - RedisStore  (ioredis, ativado quando REDIS_URL configurado + dep instalada)
 *
 * Interface uniforme (todas as funções async):
 *   get(key)             -> Promise<value | null>
 *   set(key, val, ttlMs) -> Promise<void>
 *   delete(key)          -> Promise<boolean>
 *   clear(prefix?)       -> Promise<number>
 *   size()               -> Promise<number>
 *   has(key)             -> Promise<boolean>
 *   info()               -> { backend, ... }
 *
 * Quando REDIS_URL estiver definido mas o módulo `ioredis` não estiver
 * instalado, faz fallback gracioso para memória + log de warning.
 */

'use strict';

const { logger } = require('../logger');
const metrics = require('./metrics');
const log = logger.child({ module: 'cacheStore' });

const m_get_total = metrics.counter('cachestore_get_total');
const m_get_hit   = metrics.counter('cachestore_hit_total');
const m_get_miss  = metrics.counter('cachestore_miss_total');
const m_set_total = metrics.counter('cachestore_set_total');
const m_del_total = metrics.counter('cachestore_delete_total');
const m_op_latency = metrics.histogram('cachestore_op_latency_ms');
const g_size      = metrics.gauge('cachestore_size');

const REDIS_URL  = (process.env.REDIS_URL || '').trim();
const REDIS_PREFIX = (process.env.REDIS_PREFIX || 'robotrend:').trim();
const DEFAULT_MAX_KEYS = Number(process.env.CACHE_MAX_KEYS || 5_000);

/* ============================================================
   MEMORY STORE (LRU TTL)
   ============================================================ */
class MemoryStore {
  constructor({ maxKeys = DEFAULT_MAX_KEYS } = {}) {
    this.maxKeys = maxKeys;
    this.map = new Map(); // key -> { value, expiresAt }
    this.backend = 'memory';
  }

  async get(key) {
    const t0 = Date.now();
    m_get_total.inc(1, { backend: 'memory' });
    const ent = this.map.get(key);
    const finish = () => m_op_latency.observe(Date.now() - t0, { backend: 'memory', op: 'get' });
    if (!ent) { m_get_miss.inc(1, { backend: 'memory' }); finish(); return null; }
    if (ent.expiresAt && ent.expiresAt < Date.now()) {
      this.map.delete(key);
      g_size.set(this.map.size, { backend: 'memory' });
      m_get_miss.inc(1, { backend: 'memory' }); finish();
      return null;
    }
    // refresh LRU order
    this.map.delete(key);
    this.map.set(key, ent);
    m_get_hit.inc(1, { backend: 'memory' }); finish();
    return ent.value;
  }

  async has(key) {
    return (await this.get(key)) !== null;
  }

  async set(key, value, ttlMs) {
    const t0 = Date.now();
    m_set_total.inc(1, { backend: 'memory' });
    if (this.map.size >= this.maxKeys) {
      const oldest = this.map.keys().next().value;
      if (oldest) this.map.delete(oldest);
    }
    const expiresAt = ttlMs ? Date.now() + ttlMs : 0;
    this.map.set(key, { value, expiresAt });
    g_size.set(this.map.size, { backend: 'memory' });
    m_op_latency.observe(Date.now() - t0, { backend: 'memory', op: 'set' });
  }

  async delete(key) {
    m_del_total.inc(1, { backend: 'memory' });
    const r = this.map.delete(key);
    g_size.set(this.map.size, { backend: 'memory' });
    return r;
  }

  async clear(prefix) {
    if (!prefix) {
      const n = this.map.size;
      this.map.clear();
      return n;
    }
    let n = 0;
    for (const k of [...this.map.keys()]) {
      if (k.startsWith(prefix)) { this.map.delete(k); n++; }
    }
    return n;
  }

  async size() { return this.map.size; }

  info() {
    return { backend: this.backend, size: this.map.size, maxKeys: this.maxKeys };
  }
}

/* ============================================================
   REDIS STORE
   ============================================================ */
class RedisStore {
  constructor({ url, prefix = REDIS_PREFIX }) {
    let Redis;
    try { Redis = require('ioredis'); }
    catch (e) {
      const err = new Error('ioredis não instalado — rode `npm i ioredis` ou remova REDIS_URL');
      err.code = 'IOREDIS_MISSING';
      throw err;
    }
    this.prefix = prefix;
    this.backend = 'redis';
    this.client = new Redis(url, {
      maxRetriesPerRequest: 3,
      connectTimeout: 5_000,
      enableReadyCheck: true,
      lazyConnect: false,
      keyPrefix: prefix,
      retryStrategy: (times) => Math.min(times * 200, 5_000),
    });
    this.client.on('error', (e) => log.warn('redis error', { err: e.message }));
    this.client.on('ready', () => log.info('redis ready', { url: maskUrl(url) }));
    this.client.on('end',   () => log.warn('redis connection ended'));
  }

  async get(key) {
    const t0 = Date.now();
    m_get_total.inc(1, { backend: 'redis' });
    try {
      const raw = await this.client.get(key);
      m_op_latency.observe(Date.now() - t0, { backend: 'redis', op: 'get' });
      if (raw == null) { m_get_miss.inc(1, { backend: 'redis' }); return null; }
      m_get_hit.inc(1, { backend: 'redis' });
      return JSON.parse(raw);
    } catch (e) {
      log.warn('redis.get fallback null', { key, err: e.message });
      m_get_miss.inc(1, { backend: 'redis', err: 'true' });
      return null;
    }
  }

  async has(key) {
    try { return (await this.client.exists(key)) === 1; }
    catch { return false; }
  }

  async set(key, value, ttlMs) {
    const t0 = Date.now();
    m_set_total.inc(1, { backend: 'redis' });
    const payload = JSON.stringify(value);
    try {
      if (ttlMs && ttlMs > 0) await this.client.set(key, payload, 'PX', ttlMs);
      else                    await this.client.set(key, payload);
      m_op_latency.observe(Date.now() - t0, { backend: 'redis', op: 'set' });
    } catch (e) {
      log.warn('redis.set ignored', { key, err: e.message });
    }
  }

  async delete(key) {
    m_del_total.inc(1, { backend: 'redis' });
    try { return (await this.client.del(key)) > 0; }
    catch { return false; }
  }

  async clear(prefix) {
    try {
      const match = prefix ? `${this.prefix}${prefix}*` : `${this.prefix}*`;
      const stream = this.client.scanStream({ match, count: 200 });
      let n = 0;
      await new Promise((resolve, reject) => {
        stream.on('data', async (keys) => {
          if (!keys.length) return;
          // ioredis injeta o prefix em this.client, mas scanStream devolve
          // keys ABSOLUTAS — precisamos remover o prefix antes do del().
          const stripped = keys.map((k) => k.startsWith(this.prefix) ? k.slice(this.prefix.length) : k);
          n += await this.client.del(...stripped);
        });
        stream.on('end',   resolve);
        stream.on('error', reject);
      });
      return n;
    } catch (e) {
      log.warn('redis.clear failed', { err: e.message });
      return 0;
    }
  }

  async size() {
    try {
      const stream = this.client.scanStream({ match: `${this.prefix}*`, count: 500 });
      let n = 0;
      await new Promise((resolve, reject) => {
        stream.on('data', (keys) => { n += keys.length; });
        stream.on('end', resolve);
        stream.on('error', reject);
      });
      return n;
    } catch { return -1; }
  }

  info() {
    return {
      backend: this.backend,
      prefix: this.prefix,
      status: this.client.status,
    };
  }

  async close() { try { await this.client.quit(); } catch {} }
}

function maskUrl(url) {
  return String(url).replace(/(:\/\/[^:]+:)[^@]+@/, '$1***@');
}

/* ============================================================
   FACTORY
   ============================================================ */
let _singleton = null;

function createStore(opts = {}) {
  if (REDIS_URL) {
    try {
      const store = new RedisStore({ url: REDIS_URL });
      log.info('cacheStore: redis ativo', { url: maskUrl(REDIS_URL), prefix: REDIS_PREFIX });
      return store;
    } catch (e) {
      log.warn('cacheStore: fallback para memória (Redis indisponível)', { err: e.message });
    }
  }
  log.info('cacheStore: memory ativo', { maxKeys: opts.maxKeys || DEFAULT_MAX_KEYS });
  return new MemoryStore(opts);
}

function getStore(opts) {
  if (!_singleton) _singleton = createStore(opts);
  return _singleton;
}

/**
 * Reseta o singleton (útil em testes).
 */
function _reset() { _singleton = null; }

module.exports = {
  MemoryStore,
  RedisStore,
  createStore,
  getStore,
  _reset,
};
