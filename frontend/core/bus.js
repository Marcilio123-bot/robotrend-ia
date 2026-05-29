/* ============================================================
   ROBOTREND IA — Event Bus
   ------------------------------------------------------------
   Hub central de eventos. Desacopla módulos: em vez de cada
   script adicionar listener no window e dispatchEvent, usamos:

     RobotrendBus.on('robotrend:user-ready', (payload) => ...);
     RobotrendBus.emit('robotrend:user-ready', { user });
     RobotrendBus.once('robotrend:socket-online', cb);
     RobotrendBus.off('robotrend:user-ready', cb);

   API:
     - on(event, handler)   → desinscreve via retorno: const off = bus.on(...);
     - off(event, handler)
     - once(event, handler)
     - emit(event, payload) → assíncrono via queueMicrotask (não trava o emit)
     - bridge(eventNames)   → re-emite window CustomEvent → bus

   Compat com código antigo:
     - emit('robotrend:user-ready', d) também dispara
       window.dispatchEvent(new CustomEvent('robotrend:user-ready', { detail: d }))
       para que listeners antigos continuem funcionando.
   ============================================================ */
(function () {
  'use strict';

  if (window.RobotrendBus) return;

  const map = new Map(); // event -> Set<handler>
  const recentLog = [];  // últimos N eventos para observability (debug.js consome)
  const MAX_LOG = 80;

  function ensureSet(event) {
    let set = map.get(event);
    if (!set) { set = new Set(); map.set(event, set); }
    return set;
  }

  function on(event, handler) {
    if (typeof handler !== 'function') return () => {};
    ensureSet(event).add(handler);
    return () => off(event, handler);
  }

  function off(event, handler) {
    const set = map.get(event);
    if (set) set.delete(handler);
  }

  function once(event, handler) {
    const wrap = (payload) => {
      off(event, wrap);
      try { handler(payload); } catch (e) { console.error('[RobotrendBus once]', event, e); }
    };
    return on(event, wrap);
  }

  function emit(event, payload) {
    // log para __RT_DEBUG__
    recentLog.push({ event, payload, at: Date.now() });
    if (recentLog.length > MAX_LOG) recentLog.shift();

    const set = map.get(event);
    if (set && set.size) {
      // queueMicrotask evita re-entrar no mesmo stack se um handler emitir de novo.
      queueMicrotask(() => {
        for (const h of set) {
          try { h(payload); } catch (e) { console.error('[RobotrendBus emit]', event, e); }
        }
      });
    }

    // Bridge para listeners legados que ainda escutam window CustomEvent.
    try {
      window.dispatchEvent(new CustomEvent(event, { detail: payload }));
    } catch (_) { /* CSP pode bloquear; ignorável */ }
  }

  /**
   * Bridge contrária: window CustomEvent (eventos legados como
   * 'robotrend:user-ready' disparados por auth-guard) viram emit do bus,
   * sem precisar refatorar quem dispara.
   */
  function bridge(eventNames) {
    const names = Array.isArray(eventNames) ? eventNames : [eventNames];
    for (const name of names) {
      window.addEventListener(name, (ev) => {
        // Evita loop infinito: bridge só re-emite se o evento veio de fora
        // (não foi emitido pelo próprio bus). Usa flag em `detail`.
        if (ev.detail && ev.detail.__fromBus) return;
        // marca para o emit() não criar outro CustomEvent... mas o emit
        // sempre dispara window event, então marcamos antes.
        const set = map.get(name);
        if (set && set.size) {
          queueMicrotask(() => {
            for (const h of set) {
              try { h(ev.detail); } catch (e) { console.error('[RobotrendBus bridge]', name, e); }
            }
          });
        }
        recentLog.push({ event: name, payload: ev.detail, at: Date.now(), from: 'window' });
        if (recentLog.length > MAX_LOG) recentLog.shift();
      });
    }
  }

  function recent(limit) {
    const n = Math.min(MAX_LOG, Math.max(1, limit || 20));
    return recentLog.slice(-n);
  }

  function clear() {
    map.clear();
    recentLog.length = 0;
  }

  // Bridges padrão — eventos que outras partes do sistema já disparavam.
  bridge([
    'robotrend:user-ready',
    'robotrend:upgrade-detected',
  ]);

  window.RobotrendBus = { on, off, once, emit, bridge, recent, clear };
})();
