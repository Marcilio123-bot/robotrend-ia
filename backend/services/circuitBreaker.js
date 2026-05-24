/**
 * Robotrend IA — Circuit Breaker genérico
 *
 * Estados:
 *   CLOSED     → tudo normal, requests passam
 *   OPEN       → falhas excederam o threshold, requests são curto-circuitadas
 *   HALF_OPEN  → janela de probe (1 request por vez) para reavaliar
 *
 * Uso:
 *   const cb = new CircuitBreaker({ name: 'api-football', threshold: 5, cooldownMs: 30_000 });
 *   const result = await cb.exec(() => doRequest(), { fallback: () => cachedValue });
 */

'use strict';

const { logger } = require('../logger');
const log = logger.child({ module: 'circuitBreaker' });

const STATES = Object.freeze({ CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' });

class CircuitBreakerOpenError extends Error {
  constructor(name) {
    super(`Circuit "${name}" is OPEN`);
    this.code = 'CIRCUIT_OPEN';
    this.circuit = name;
  }
}

class CircuitBreaker {
  /**
   * @param {object} opts
   * @param {string} opts.name
   * @param {number} [opts.threshold=5]      falhas consecutivas para abrir
   * @param {number} [opts.cooldownMs=30000] tempo OPEN antes de tentar HALF_OPEN
   * @param {number} [opts.probeSuccesses=2] sucessos consecutivos em HALF_OPEN p/ fechar
   * @param {(err)=>boolean} [opts.isFailure] decide se um erro conta como falha
   */
  constructor(opts = {}) {
    this.name           = opts.name || 'breaker';
    this.threshold      = Number(opts.threshold      ?? 5);
    this.cooldownMs     = Number(opts.cooldownMs     ?? 30_000);
    this.probeSuccesses = Number(opts.probeSuccesses ?? 2);
    this.isFailure      = typeof opts.isFailure === 'function' ? opts.isFailure : () => true;

    this.state = STATES.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.openedAt = 0;
    this.lastError = null;
    this.lastTrip = 0;
    this.totals = { exec: 0, success: 0, fail: 0, shortCircuit: 0, trips: 0 };
  }

  snapshot() {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      threshold: this.threshold,
      cooldownMs: this.cooldownMs,
      openedAt: this.openedAt || null,
      lastError: this.lastError ? String(this.lastError).slice(0, 200) : null,
      lastTrip: this.lastTrip || null,
      totals: { ...this.totals },
    };
  }

  /** Força um estado. Usado em testes. */
  _force(state) {
    this.state = state;
    if (state === STATES.OPEN) this.openedAt = Date.now();
    if (state === STATES.CLOSED) { this.failures = 0; this.successes = 0; }
  }

  /**
   * Executa `fn`. Se o breaker estiver OPEN, faz curto-circuito (lança ou chama fallback).
   * @param {() => Promise<any>} fn
   * @param {object} [opts]
   * @param {(err)=>Promise<any>} [opts.fallback]
   * @returns {Promise<any>}
   */
  async exec(fn, opts = {}) {
    this.totals.exec++;

    // Transição automática OPEN → HALF_OPEN se passou o cooldown
    if (this.state === STATES.OPEN) {
      if (Date.now() - this.openedAt >= this.cooldownMs) {
        this.state = STATES.HALF_OPEN;
        this.successes = 0;
        log.info('circuit half-open (probe)', { name: this.name });
      } else {
        this.totals.shortCircuit++;
        if (opts.fallback) {
          try { return await opts.fallback(new CircuitBreakerOpenError(this.name)); }
          catch (e) { throw e; }
        }
        throw new CircuitBreakerOpenError(this.name);
      }
    }

    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (err) {
      if (this.isFailure(err)) {
        this._onFailure(err);
      } else {
        this._onSuccess(); // erros "ignoráveis" não contam (4xx negocial, etc.)
      }
      if (opts.fallback) {
        try { return await opts.fallback(err); }
        catch (e) { throw err; }
      }
      throw err;
    }
  }

  _onSuccess() {
    this.totals.success++;
    if (this.state === STATES.HALF_OPEN) {
      this.successes++;
      if (this.successes >= this.probeSuccesses) {
        this._reset(`half-open recovered (${this.successes} probes)`);
      }
    } else if (this.state === STATES.CLOSED) {
      this.failures = 0;
    }
  }

  _onFailure(err) {
    this.totals.fail++;
    this.lastError = err?.message || String(err);
    if (this.state === STATES.HALF_OPEN) {
      this._trip(`half-open probe failed: ${this.lastError}`);
      return;
    }
    this.failures++;
    if (this.failures >= this.threshold) {
      this._trip(`threshold ${this.threshold} reached`);
    }
  }

  _trip(reason) {
    this.state = STATES.OPEN;
    this.openedAt = Date.now();
    this.lastTrip = this.openedAt;
    this.totals.trips++;
    log.warn('circuit OPEN', { name: this.name, reason });
  }

  _reset(reason) {
    this.state = STATES.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.openedAt = 0;
    log.info('circuit CLOSED', { name: this.name, reason });
  }
}

module.exports = {
  CircuitBreaker,
  CircuitBreakerOpenError,
  STATES,
};
