/* ============================================================
   ROBOTREND IA — __RT_DEBUG__ Observability
   ------------------------------------------------------------
   Expõe um hub introspectivo para debug rápido no console:

     __RT_DEBUG__.snapshot()
     __RT_DEBUG__.events(20)
     __RT_DEBUG__.rest                    → últimas 20 chamadas REST
     __RT_DEBUG__.socket                  → estado + reconnects + último evento
     __RT_DEBUG__.heartbeat               → snapshot do heartbeat
     __RT_DEBUG__.poller                  → últimos lastTickMs (rolling 30 amostras)
     __RT_DEBUG__.renders                 → contador de renders por componente
     __RT_DEBUG__.print()                 → pretty print no console

   Hooks automáticos:
     - intercepta window.fetch para registrar chamadas REST + duração
     - escuta robotrend:* no RobotrendBus
     - lê snapshot do RobotrendHeartbeat / RobotrendConnection
     - lê últimos eventos do RobotrendBus.recent()

   Cuidado: NÃO loga payloads sensíveis (apenas URL + status + ms).
   ============================================================ */
(function () {
  'use strict';

  if (window.__RT_DEBUG__) return;

  const restLog   = [];
  const restMax   = 25;
  const pollerLat = []; // rolling lastTickMs
  const pollerMax = 30;
  const renders   = new Map(); // component name -> count

  /* ============================================================
     fetch interceptor — instrumenta REST sem precisar marcar manualmente
     ============================================================ */
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function instrumentedFetch(input, init) {
      const url = typeof input === 'string' ? input : (input?.url || '');
      const start = performance.now();
      const p = origFetch.apply(this, arguments);
      p.then((res) => {
        const ms = Math.round(performance.now() - start);
        push({ url, status: res?.status ?? 0, ms, at: Date.now() });
      }).catch((err) => {
        const ms = Math.round(performance.now() - start);
        push({ url, status: 0, ms, at: Date.now(), error: err?.message || String(err) });
      });
      return p;
    };
  }

  function push(entry) {
    restLog.push(entry);
    if (restLog.length > restMax) restLog.shift();
  }

  /* ============================================================
     RENDERS — componentes chamam __RT_DEBUG__.tickRender('name')
     ============================================================ */
  function tickRender(component) {
    const cur = renders.get(component) || 0;
    renders.set(component, cur + 1);
  }

  function rendersSnapshot() {
    const out = {};
    for (const [k, v] of renders) out[k] = v;
    return out;
  }

  /* ============================================================
     POLLER LATENCY — ops-status pode alimentar via pushPollerSample
     ============================================================ */
  function pushPollerSample(ms) {
    if (!Number.isFinite(ms)) return;
    pollerLat.push(ms);
    if (pollerLat.length > pollerMax) pollerLat.shift();
  }

  function pollerStats() {
    if (!pollerLat.length) return { samples: 0, avgMs: null, lastMs: null, history: [] };
    const sum = pollerLat.reduce((a, b) => a + b, 0);
    return {
      samples: pollerLat.length,
      avgMs:   Math.round(sum / pollerLat.length),
      lastMs:  pollerLat[pollerLat.length - 1],
      history: pollerLat.slice(),
    };
  }

  /* ============================================================
     PUBLIC API
     ============================================================ */
  const api = {
    get rest()      { return restLog.slice(); },
    get socket()    { return window.RobotrendConnection?.snapshot ?? null; },
    get heartbeat() { return window.RobotrendHeartbeat?.state ?? null; },
    get bus()       { return window.RobotrendBus?.recent(30) ?? []; },
    get poller()    { return pollerStats(); },
    get renders()   { return rendersSnapshot(); },
    get user()      { return window.RobotrendUser?.get?.() ?? null; },
    get provider()  { return window.__RT_DEBUG_provider || null; },

    tickRender,
    pushPollerSample,

    events(limit = 20) { return window.RobotrendBus?.recent(limit) ?? []; },

    snapshot() {
      return {
        timestamp: new Date().toISOString(),
        socket: api.socket,
        heartbeat: api.heartbeat,
        rest: api.rest.slice(-10),
        bus: api.bus.slice(-10),
        poller: api.poller,
        renders: api.renders,
        user: api.user ? { role: api.user.role, plan: api.user.plan, email: api.user.user?.email } : null,
        provider: api.provider,
        url: location.href,
      };
    },

    print() {
      const s = api.snapshot();
      console.group('%c⚡ Robotrend Debug Snapshot', 'color:#14b85e;font-weight:bold;');
      console.log('Socket:', s.socket);
      console.log('Heartbeat:', s.heartbeat);
      console.log('Provider:', s.provider);
      console.log('Poller (lastTickMs rolling):', s.poller);
      console.log('Renders:', s.renders);
      console.log('Last REST calls:', s.rest);
      console.log('Last bus events:', s.bus);
      console.log('User:', s.user);
      console.groupEnd();
      return s;
    },
  };

  window.__RT_DEBUG__ = api;

  // Atalho de teclado: Ctrl+Shift+D imprime snapshot
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === 'd' || e.key === 'D')) {
      e.preventDefault();
      api.print();
    }
  });
})();
