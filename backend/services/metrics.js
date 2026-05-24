/**
 * Robotrend IA — Metrics Registry
 *
 * Sistema de métricas in-process com:
 *
 *   - Counter        : incremento monotônico  (api.calls, cache.hit, etc.)
 *   - Gauge          : valor pontual          (sockets.connected, poller.tracked)
 *   - Histogram      : distribuição (count, sum, avg, p50, p95, p99, min, max)
 *                      usando reservoir sampling de tamanho fixo
 *   - SlidingWindow  : taxa por segundo / janela móvel (eventos/seg)
 *
 * Output:
 *   - registry.snapshot()  -> JSON estruturado, friendly p/ painel
 *   - registry.prometheus() -> texto compat. com Prometheus exposition format
 *
 * Em memória, sem deps externas. Zero overhead quando não consultado.
 */

'use strict';

const RESERVOIR_DEFAULT = 256;

/* ============================================================
   COUNTER (monotonic)
   ============================================================ */
class Counter {
  constructor(name, help = '') {
    this.name = name; this.help = help;
    this.values = new Map(); // labelsKey -> number
  }
  inc(by = 1, labels = null) {
    const k = labelsKey(labels);
    this.values.set(k, (this.values.get(k) || 0) + by);
  }
  reset(labels = null) {
    if (labels) this.values.delete(labelsKey(labels));
    else this.values.clear();
  }
  get(labels = null) { return this.values.get(labelsKey(labels)) || 0; }
  snapshot() {
    return Array.from(this.values.entries()).map(([k, v]) => ({
      labels: parseLabels(k), value: v,
    }));
  }
}

/* ============================================================
   GAUGE (pontual)
   ============================================================ */
class Gauge {
  constructor(name, help = '') { this.name = name; this.help = help; this.values = new Map(); }
  set(value, labels = null) { this.values.set(labelsKey(labels), value); }
  inc(by = 1, labels = null) {
    const k = labelsKey(labels);
    this.values.set(k, (this.values.get(k) || 0) + by);
  }
  dec(by = 1, labels = null) { this.inc(-by, labels); }
  get(labels = null) { return this.values.get(labelsKey(labels)) || 0; }
  snapshot() {
    return Array.from(this.values.entries()).map(([k, v]) => ({
      labels: parseLabels(k), value: v,
    }));
  }
}

/* ============================================================
   HISTOGRAM (reservoir sampling para percentis)
   ============================================================ */
class Histogram {
  constructor(name, help = '', { reservoir = RESERVOIR_DEFAULT } = {}) {
    this.name = name; this.help = help;
    this.reservoir = reservoir;
    this.streams = new Map(); // labelsKey -> { samples, count, sum, min, max }
  }

  observe(value, labels = null) {
    if (!Number.isFinite(value)) return;
    const k = labelsKey(labels);
    let s = this.streams.get(k);
    if (!s) {
      s = { samples: new Array(this.reservoir).fill(null), count: 0, sum: 0, min: Infinity, max: -Infinity };
      this.streams.set(k, s);
    }
    s.count++;
    s.sum += value;
    if (value < s.min) s.min = value;
    if (value > s.max) s.max = value;
    // Reservoir sampling (Vitter R)
    if (s.count <= this.reservoir) {
      s.samples[s.count - 1] = value;
    } else {
      const j = Math.floor(Math.random() * s.count);
      if (j < this.reservoir) s.samples[j] = value;
    }
  }

  percentiles(labels = null, ps = [50, 95, 99]) {
    const s = this.streams.get(labelsKey(labels));
    if (!s || !s.count) return ps.reduce((o, p) => (o[`p${p}`] = null, o), {});
    const sorted = s.samples.filter((v) => v != null).sort((a, b) => a - b);
    const out = {};
    for (const p of ps) {
      const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
      out[`p${p}`] = sorted[idx] ?? null;
    }
    return out;
  }

  snapshot() {
    return Array.from(this.streams.entries()).map(([k, s]) => ({
      labels: parseLabels(k),
      count: s.count,
      sum: +s.sum.toFixed(2),
      avg: s.count ? +(s.sum / s.count).toFixed(2) : 0,
      min: s.min === Infinity ? null : +s.min.toFixed(2),
      max: s.max === -Infinity ? null : +s.max.toFixed(2),
      ...this.percentiles(parseLabels(k)),
    }));
  }
}

/* ============================================================
   SLIDING WINDOW (rate per second over window)
   ============================================================ */
class SlidingWindow {
  constructor(name, { windowMs = 60_000, bucketMs = 1_000 } = {}) {
    this.name = name;
    this.windowMs = windowMs;
    this.bucketMs = bucketMs;
    this.buckets = []; // [{ ts, count }]
  }
  hit(by = 1) {
    const now = Date.now();
    const slot = Math.floor(now / this.bucketMs);
    const last = this.buckets[this.buckets.length - 1];
    if (last && last.ts === slot) last.count += by;
    else this.buckets.push({ ts: slot, count: by });
    this._evict(now);
  }
  _evict(now) {
    const cutoff = Math.floor((now - this.windowMs) / this.bucketMs);
    while (this.buckets.length && this.buckets[0].ts < cutoff) this.buckets.shift();
  }
  snapshot() {
    this._evict(Date.now());
    const total = this.buckets.reduce((s, b) => s + b.count, 0);
    return {
      windowMs: this.windowMs,
      bucketCount: this.buckets.length,
      total,
      perSecond: +(total / (this.windowMs / 1000)).toFixed(2),
    };
  }
}

/* ============================================================
   LABEL HELPERS
   ============================================================ */
function labelsKey(labels) {
  if (!labels) return '';
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([k, v]) => `${k}=${v}`).join('|');
}
function parseLabels(key) {
  if (!key) return {};
  const out = {};
  for (const pair of key.split('|')) {
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return out;
}

/* ============================================================
   REGISTRY (singleton)
   ============================================================ */
class Registry {
  constructor() {
    this.bootAt = Date.now();
    this.counters   = new Map();
    this.gauges     = new Map();
    this.histograms = new Map();
    this.windows    = new Map();
  }

  counter(name, help = '') {
    if (!this.counters.has(name)) this.counters.set(name, new Counter(name, help));
    return this.counters.get(name);
  }
  gauge(name, help = '') {
    if (!this.gauges.has(name)) this.gauges.set(name, new Gauge(name, help));
    return this.gauges.get(name);
  }
  histogram(name, help = '', opts) {
    if (!this.histograms.has(name)) this.histograms.set(name, new Histogram(name, help, opts));
    return this.histograms.get(name);
  }
  window(name, opts) {
    if (!this.windows.has(name)) this.windows.set(name, new SlidingWindow(name, opts));
    return this.windows.get(name);
  }

  /**
   * Wrap async/sync fn for histogram observation.
   *   metrics.time('api.fetch', { endpoint: 'fixtures' }, () => fetch(...))
   */
  async time(histName, labels, fn) {
    const h = this.histogram(histName);
    const t0 = process.hrtime.bigint();
    try {
      const out = await fn();
      const ms = Number((process.hrtime.bigint() - t0) / 1_000_000n);
      h.observe(ms, labels);
      return out;
    } catch (err) {
      const ms = Number((process.hrtime.bigint() - t0) / 1_000_000n);
      h.observe(ms, { ...labels, error: 'true' });
      throw err;
    }
  }

  snapshot() {
    const memo = process.memoryUsage();
    return {
      bootAt: new Date(this.bootAt).toISOString(),
      uptimeSec: Math.round((Date.now() - this.bootAt) / 1000),
      process: {
        rss: memo.rss,
        heapUsed: memo.heapUsed,
        heapTotal: memo.heapTotal,
        external: memo.external,
        rssMB: +(memo.rss / 1024 / 1024).toFixed(1),
        heapMB: +(memo.heapUsed / 1024 / 1024).toFixed(1),
      },
      counters: Object.fromEntries(
        Array.from(this.counters.values()).map((c) => [c.name, c.snapshot()])
      ),
      gauges: Object.fromEntries(
        Array.from(this.gauges.values()).map((g) => [g.name, g.snapshot()])
      ),
      histograms: Object.fromEntries(
        Array.from(this.histograms.values()).map((h) => [h.name, h.snapshot()])
      ),
      windows: Object.fromEntries(
        Array.from(this.windows.values()).map((w) => [w.name, w.snapshot()])
      ),
    };
  }

  /**
   * Saída em formato Prometheus (text/plain; version=0.0.4)
   */
  prometheus() {
    const lines = [];
    const safe = (s) => String(s).replace(/[^a-zA-Z0-9_]/g, '_');
    const labelStr = (labels) => {
      const e = Object.entries(labels || {});
      if (!e.length) return '';
      return '{' + e.map(([k, v]) => `${safe(k)}="${String(v).replace(/"/g, '\\"')}"`).join(',') + '}';
    };

    for (const c of this.counters.values()) {
      if (c.help) lines.push(`# HELP ${safe(c.name)} ${c.help}`);
      lines.push(`# TYPE ${safe(c.name)} counter`);
      for (const s of c.snapshot()) lines.push(`${safe(c.name)}${labelStr(s.labels)} ${s.value}`);
    }
    for (const g of this.gauges.values()) {
      if (g.help) lines.push(`# HELP ${safe(g.name)} ${g.help}`);
      lines.push(`# TYPE ${safe(g.name)} gauge`);
      for (const s of g.snapshot()) lines.push(`${safe(g.name)}${labelStr(s.labels)} ${s.value}`);
    }
    for (const h of this.histograms.values()) {
      if (h.help) lines.push(`# HELP ${safe(h.name)} ${h.help}`);
      lines.push(`# TYPE ${safe(h.name)} summary`);
      for (const s of h.snapshot()) {
        const ls = labelStr(s.labels);
        lines.push(`${safe(h.name)}_count${ls} ${s.count}`);
        lines.push(`${safe(h.name)}_sum${ls} ${s.sum}`);
        if (s.p50 != null) lines.push(`${safe(h.name)}${labelStr({ ...s.labels, quantile: '0.5' })} ${s.p50}`);
        if (s.p95 != null) lines.push(`${safe(h.name)}${labelStr({ ...s.labels, quantile: '0.95' })} ${s.p95}`);
        if (s.p99 != null) lines.push(`${safe(h.name)}${labelStr({ ...s.labels, quantile: '0.99' })} ${s.p99}`);
      }
    }
    return lines.join('\n') + '\n';
  }
}

const registry = new Registry();
module.exports = registry;
module.exports.Registry = Registry;
module.exports.Counter = Counter;
module.exports.Gauge = Gauge;
module.exports.Histogram = Histogram;
module.exports.SlidingWindow = SlidingWindow;
