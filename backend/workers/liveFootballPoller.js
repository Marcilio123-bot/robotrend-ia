/**
 * Robotrend IA — Live Football Poller (worker)
 *
 * SINGLE OWNER de todas as chamadas live à API-Sports. Em vez de cada
 * usuário/módulo disparar polling, este worker faz UMA chamada por
 * intervalo e fan-out via EventBus para:
 *
 *   - socket.io (footballRealtime)
 *   - alertas Telegram (footballAlerts)
 *   - persistência (footballHistory)
 *   - métricas
 *
 * Benefícios:
 *   - 1 chamada por tick mesmo com 1000 usuários conectados
 *   - Quota da API protegida
 *   - Cache do apiFootball já trata burst de subscribers
 *
 * Pode rodar embarcado no servidor (default) ou em um processo
 * separado (`node backend/worker.js`) lendo de um Redis Pub/Sub.
 *
 * Eventos emitidos:
 *   tick, matches:update, match:upsert, match:update, match:remove,
 *   fixture:goal, fixture:corner, fixture:card, fixture:pressure,
 *   fixture:btts-near, poller:error
 */

'use strict';

const apiFootball = require('../services/apiFootball');
const history     = require('../services/footballHistory');
const events      = require('../services/footballEvents');
const metrics     = require('../services/metrics');
const { normalizeFixture } = require('../services/fixtureNormalizer');
const { logger }  = require('../logger');

const log = logger.child({ module: 'liveFootballPoller' });

const m_ticks       = metrics.counter('poller_ticks_total');
const m_ticks_fail  = metrics.counter('poller_ticks_failed_total');
const m_tick_lat    = metrics.histogram('poller_tick_duration_ms');
const m_events_pub  = metrics.counter('poller_events_published_total');
const g_tracked     = metrics.gauge('poller_tracked_matches');
const g_running     = metrics.gauge('poller_running', '1 quando ativo, 0 quando parado');
const w_events      = metrics.window('poller_events_window', { windowMs: 60_000 });

// Default ULTRA-conservador: 5 min. Em plano grátis (95 req/dia) configure
// 1200000 (20min) no .env. O default antigo de 12s estourava 7200 req/dia,
// queimando a quota em < 30 min — esse era o bug raiz reportado.
const INTERVAL_MS         = Number(process.env.FOOTBALL_POLL_INTERVAL_MS || 300_000);
const PRESSURE_DELTA      = Number(process.env.FOOTBALL_PRESSURE_DELTA || 12);
const BTTS_NEAR_MIN_PRESS = Number(process.env.FOOTBALL_BTTS_NEAR_MIN_PRESSURE || 65);

class LiveFootballPoller {
  constructor(opts = {}) {
    this.intervalMs = Number(opts.intervalMs || INTERVAL_MS);
    this.timer = null;
    this.running = false;
    this.ticking = false;
    this.lastTickAt = 0;
    this.cache = new Map(); // fixtureId -> last normalized match
    this.stats = { ticks: 0, ticksFailed: 0, lastDurationMs: 0, lastSize: 0 };
  }

  start() {
    if (this.running) return;
    this.running = true;
    g_running.set(1);
    log.info('poller started', { intervalMs: this.intervalMs });
    setTimeout(() => this.tick().catch((e) => log.error('first tick error', { err: e.message })), 500);
    this.timer = setInterval(
      () => this.tick().catch((e) => log.error('tick error', { err: e.message })),
      this.intervalMs
    );
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
    g_running.set(0);
    log.info('poller stopped');
  }

  snapshot() {
    return {
      running: this.running,
      intervalMs: this.intervalMs,
      lastTickAt: this.lastTickAt,
      stats: { ...this.stats },
      tracked: this.cache.size,
    };
  }

  /**
   * Snapshot atual das partidas (sem custo de API — usa cache do poller).
   */
  getMatches() {
    return Array.from(this.cache.values());
  }

  getMatch(id) {
    return this.cache.get(String(id)) || null;
  }

  async tick() {
    if (this.ticking) return; // evita overlap
    this.ticking = true;
    const t0 = Date.now();
    try {
      const raw = await apiFootball.getLiveFixtures();
      const matches = raw
        .map((fx) => {
          try { return normalizeFixture(fx); }
          catch (e) { return null; }
        })
        .filter(Boolean);

      this.stats.lastSize = matches.length;
      this.stats.ticks++;
      m_ticks.inc(1, { source: raw.__stale ? 'stale' : 'live' });
      this.lastTickAt = Date.now();
      g_tracked.set(matches.length);

      const fromStale = !!raw.__stale;
      const seen = new Set();

      // Detecta upsert / update / events
      for (const m of matches) {
        const id = String(m.id);
        seen.add(id);
        const prev = this.cache.get(id);

        // CRÍTICO: preserva enrichment anterior. O endpoint live não devolve
        // statistics — se regenerássemos o match do zero, perderíamos toda a
        // pressão/corners/cards/etc. acumulados pelo enricher. O enricher
        // refaz isso na sua cadência (default 30min).
        if (prev?.enriched && !m.enriched) {
          m.stats        = prev.stats;
          m.perMinute    = prev.perMinute;
          m.momentum     = prev.momentum;
          m.bttsLikelihood = prev.bttsLikelihood;
          m.events       = prev.events || [];
          m.enriched     = true;
          m.enrichedAt   = prev.enrichedAt;
          m.enrichedPartial = prev.enrichedPartial;
          m.insight      = prev.insight;
          m.signals      = prev.signals;
        } else if (!m.enriched && prev) {
          // Preserva partial enrichment entre ticks skeleton
          if (prev.enrichedPartial) {
            m.stats = prev.stats;
            m.perMinute = prev.perMinute;
            m.momentum = prev.momentum;
            m.bttsLikelihood = prev.bttsLikelihood;
            m.events = prev.events || [];
            m.enriched = true;
            m.enrichedPartial = true;
            m.enrichedAt = prev.enrichedAt;
            m.insight = prev.insight;
            m.signals = prev.signals;
          }
        }

        // Persistência (não bloqueia loop)
        history.recordSnapshot(m, { prev }).catch(() => {});

        if (!prev) {
          this.cache.set(id, m);
          events.emit('match:upsert', { match: m });
          continue;
        }

        const deltas = computeDeltas(prev, m);
        this.cache.set(id, m);

        if (deltas.changed) {
          events.emit('match:update', { match: m, prev, deltas });

          // Eventos específicos para alertas/UI
          if (deltas.goalHome > 0) {
            events.emit('fixture:goal', { match: m, side: 'home', delta: deltas.goalHome });
            history.recordEvent({ matchId: m.fixtureId, kind: 'goal', side: 'home', minute: m.minute }).catch(() => {});
          }
          if (deltas.goalAway > 0) {
            events.emit('fixture:goal', { match: m, side: 'away', delta: deltas.goalAway });
            history.recordEvent({ matchId: m.fixtureId, kind: 'goal', side: 'away', minute: m.minute }).catch(() => {});
          }
          if (deltas.cornersTotal > 0) {
            const side = deltas.cornersHome > 0 ? 'home' : deltas.cornersAway > 0 ? 'away' : 'unknown';
            events.emit('fixture:corner', { match: m, side, delta: deltas.cornersTotal });
            history.recordEvent({ matchId: m.fixtureId, kind: 'corner', side, minute: m.minute }).catch(() => {});
          }
          if (deltas.yellowTotal > 0) {
            events.emit('fixture:card', { match: m, color: 'yellow', delta: deltas.yellowTotal });
            history.recordEvent({ matchId: m.fixtureId, kind: 'card-yellow', minute: m.minute }).catch(() => {});
          }
          if (deltas.redTotal > 0) {
            events.emit('fixture:card', { match: m, color: 'red', delta: deltas.redTotal });
            history.recordEvent({ matchId: m.fixtureId, kind: 'card-red', minute: m.minute }).catch(() => {});
          }
          if (deltas.pressureDelta >= PRESSURE_DELTA) {
            events.emit('fixture:pressure', {
              match: m,
              pressure: m.perMinute?.pressureIndex,
              delta: deltas.pressureDelta,
            });
          }
          // BTTS iminente: 1 time já marcou + pressão alta do outro
          if (isBttsNear(m, prev)) {
            events.emit('fixture:btts-near', { match: m, reason: 'pressão alta com 1×0' });
          }
        }
      }

      // Remoção de matches que sumiram (jogo encerrou ou saiu de live)
      for (const id of [...this.cache.keys()]) {
        if (!seen.has(id)) {
          const removed = this.cache.get(id);
          this.cache.delete(id);
          events.emit('match:remove', { matchId: id, match: removed });
        }
      }

      // Snapshot global (uso pelo realtime + dashboards)
      this.stats.lastDurationMs = Date.now() - t0;
      m_tick_lat.observe(this.stats.lastDurationMs, { source: fromStale ? 'stale' : 'live' });
      const payload = {
        matches,
        generatedAt: new Date().toISOString(),
        durationMs: this.stats.lastDurationMs,
        source: fromStale ? 'stale-cache' : 'live',
        fromStale,
      };
      events.emit('tick', payload);
      events.emit('matches:update', payload);

      // Enricher bootstrap (minimal sync local; API queue só fora de safe-mode).
      // Em safe-mode o próprio bootstrapTop curto-circuita o enfileiramento
      // de chamadas reais — só aplica signals locais.
      try {
        const { getEnricher } = require('../services/fixtureEnricher');
        getEnricher().bootstrapTop(matches);
      } catch (_) { /* enricher opcional */ }
      m_events_pub.inc(2, { kind: 'tick' });
      w_events.hit(2);

    } catch (err) {
      this.stats.ticksFailed++;
      m_ticks_fail.inc();
      log.warn('tick failed', { err: err.message, code: err.code });
      events.emit('poller:error', { err: err.message, code: err.code });
      m_events_pub.inc(1, { kind: 'error' });
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Força um refresh imediato (usado por endpoints REST que precisam de dados fresquinhos).
   * Não acumula ticks: se já tem um rodando, devolve o snapshot atual.
   */
  async forceRefresh() {
    if (!this.ticking) await this.tick();
    return this.getMatches();
  }
}

/* ============================================================
   HELPERS
   ============================================================ */
function n(v) { return Number.isFinite(Number(v)) ? Number(v) : 0; }

function computeDeltas(prev, cur) {
  const out = {
    changed: false,
    goalHome: 0, goalAway: 0,
    cornersHome: 0, cornersAway: 0, cornersTotal: 0,
    yellowTotal: 0, redTotal: 0,
    pressureDelta: 0,
  };
  out.goalHome     = Math.max(0, n(cur.score?.home) - n(prev.score?.home));
  out.goalAway     = Math.max(0, n(cur.score?.away) - n(prev.score?.away));
  out.cornersHome  = Math.max(0, n(cur.stats?.corners?.home) - n(prev.stats?.corners?.home));
  out.cornersAway  = Math.max(0, n(cur.stats?.corners?.away) - n(prev.stats?.corners?.away));
  out.cornersTotal = out.cornersHome + out.cornersAway;
  out.yellowTotal  = Math.max(0, n(cur.stats?.cards?.yellow?.total) - n(prev.stats?.cards?.yellow?.total));
  out.redTotal     = Math.max(0, n(cur.stats?.cards?.red?.total)    - n(prev.stats?.cards?.red?.total));
  out.pressureDelta = n(cur.perMinute?.pressureIndex) - n(prev.perMinute?.pressureIndex);

  out.changed = !!(
    out.goalHome || out.goalAway ||
    out.cornersTotal ||
    out.yellowTotal || out.redTotal ||
    cur.minute !== prev.minute
  );
  return out;
}

function isBttsNear(cur, prev) {
  const sh = n(cur.score?.home), sa = n(cur.score?.away);
  const min = n(cur.minute);
  if (min < 30) return false;
  if (sh > 0 && sa > 0) return false; // BTTS já aconteceu
  if (sh === 0 && sa === 0) return false; // ninguém marcou
  const losingSidePressure = sh > sa
    ? n(cur.stats?.shotsOnTarget?.away) * 8 + n(cur.stats?.dangerousAttacks?.away) * 0.4
    : n(cur.stats?.shotsOnTarget?.home) * 8 + n(cur.stats?.dangerousAttacks?.home) * 0.4;
  return losingSidePressure >= BTTS_NEAR_MIN_PRESS;
}

/* ============================================================
   SINGLETON
   ============================================================ */
let _singleton = null;
function getPoller() {
  if (!_singleton) _singleton = new LiveFootballPoller();
  return _singleton;
}

module.exports = { LiveFootballPoller, getPoller };
