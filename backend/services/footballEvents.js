/**
 * Robotrend IA — Football Event Bus
 *
 * Singleton EventEmitter usado para desacoplar o poller (produtor) dos
 * vários consumidores (socket.io, alertas Telegram, persistência de
 * snapshots, métricas).
 *
 * Eventos emitidos pelo poller:
 *
 *   tick                 -> { matches, generatedAt, durationMs, source }
 *   matches:update       -> { matches }  alias de tick (compat com bot.js)
 *   match:upsert         -> { match }    primeira vez que um match aparece no ciclo
 *   match:update         -> { match, prev, deltas } stats mudaram
 *   match:remove         -> { matchId, match } sumiu (provavelmente terminou)
 *   fixture:goal         -> { match, scorer: 'home'|'away' }
 *   fixture:corner       -> { match, side: 'home'|'away'|'unknown', delta }
 *   fixture:card         -> { match, color: 'yellow'|'red', side, delta }
 *   fixture:pressure     -> { match, pressure, delta } pressão subiu >= PRESSURE_DELTA
 *   fixture:btts-near    -> { match, reason }
 *   quota                -> { quota }  snapshot periódico
 *   quota:low            -> { remaining, limit }
 *   poller:error         -> { err, source }
 *   circuit:open         -> { name, lastError }
 *   circuit:close        -> { name }
 *
 * Consumidores usam `events.on('match:update', ...)`. Tudo plano e
 * loosely-coupled: nenhum import circular, nenhum acoplamento direto.
 */

'use strict';

const { EventEmitter } = require('events');

class FootballEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100); // múltiplos subscribers (socket, alerts, history, metrics)
    this.stats = { emitted: 0, byEvent: Object.create(null) };
  }

  emit(event, payload) {
    this.stats.emitted++;
    this.stats.byEvent[event] = (this.stats.byEvent[event] || 0) + 1;
    return super.emit(event, payload);
  }

  snapshot() {
    return {
      emitted: this.stats.emitted,
      byEvent: { ...this.stats.byEvent },
      listeners: Object.fromEntries(
        this.eventNames().map((n) => [n, this.listenerCount(n)])
      ),
    };
  }
}

const bus = new FootballEventBus();

module.exports = bus;
module.exports.FootballEventBus = FootballEventBus;
