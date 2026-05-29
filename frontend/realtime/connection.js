/* ============================================================
   ROBOTREND IA — Resilient Realtime Connection
   ------------------------------------------------------------
   Anexa-se a uma instância de socket.io e adiciona:

     - contador de tentativas de reconnect
     - jitter + exponential backoff visual (apenas para UI; o
       backoff real do socket.io já roda — aqui só refletimos)
     - emit no RobotrendBus: 'robotrend:socket-state'
     - fallback polling automático quando socket fica offline
       muito tempo (configurável)
     - toast informativo quando offline > THRESHOLD_TOAST_MS

   API:
     RobotrendConnection.attach(socket, opts?)
       opts: {
         offlineToastAfterMs  — quanto tempo offline até notificar (default 8000)
         pollFallback         — { interval, maxInterval, callback } (default off)
       }
     RobotrendConnection.state      → 'online' | 'pending' | 'offline'
     RobotrendConnection.reconnects → number
   ============================================================ */
(function () {
  'use strict';

  if (window.RobotrendConnection) return;

  const state = {
    socket: null,
    state: 'pending',
    reconnects: 0,
    lastConnectedAt: null,
    lastDisconnectedAt: null,
    offlineToastShown: false,
    pollTimer: null,
    pollInterval: null,
  };

  function setState(next) {
    if (state.state === next) return;
    state.state = next;
    try { window.RobotrendBus?.emit('robotrend:socket-state', { state: next, reconnects: state.reconnects }); } catch (_) {}
    try { window.RobotrendHeartbeat?.markSocketState(next === 'online' ? 'online' : next === 'pending' ? 'pending' : 'offline'); } catch (_) {}
  }

  function startFallbackPolling(opts) {
    if (!opts?.callback) return;
    if (state.pollTimer) return;
    state.pollInterval = opts.interval || 10000;
    const max = opts.maxInterval || 30000;
    const run = () => {
      try { opts.callback(); } catch (e) { console.warn('[RobotrendConnection poll]', e); }
      // Backoff progressivo até max
      state.pollInterval = Math.min(max, Math.floor(state.pollInterval * 1.4));
      state.pollTimer = setTimeout(run, state.pollInterval);
    };
    state.pollTimer = setTimeout(run, opts.interval || 10000);
  }

  function stopFallbackPolling() {
    if (state.pollTimer) {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }
    state.pollInterval = null;
  }

  function attach(socket, opts = {}) {
    if (!socket) return;
    state.socket = socket;
    const offlineThreshold = opts.offlineToastAfterMs ?? 8000;

    socket.on('connect', () => {
      state.lastConnectedAt = Date.now();
      setState('online');
      stopFallbackPolling();
      if (state.offlineToastShown) {
        state.offlineToastShown = false;
        try {
          window.RobotrendToast?.success(
            'Conexão restabelecida',
            state.reconnects > 0 ? `após ${state.reconnects} tentativa(s)` : null,
            { ttl: 3500 }
          );
        } catch (_) {}
      }
    });

    socket.io.on('reconnect_attempt', (n) => {
      state.reconnects = Number(n) || (state.reconnects + 1);
      setState('pending');
      // Não spam toast — apenas no primeiro attempt e em intervalos
      if (state.reconnects === 1 || state.reconnects % 5 === 0) {
        try { window.RobotrendBus?.emit('robotrend:socket-reconnect', { attempt: state.reconnects }); } catch (_) {}
      }
    });

    socket.on('disconnect', (reason) => {
      state.lastDisconnectedAt = Date.now();
      setState('offline');

      // Após threshold offline, mostra toast warning e ativa fallback polling.
      setTimeout(() => {
        if (state.state === 'online') return; // reconectou no meio tempo
        if (!state.offlineToastShown) {
          state.offlineToastShown = true;
          try {
            window.RobotrendToast?.warning(
              'Sem conexão em tempo real',
              `Tentando reconectar… (${reason || 'desconhecido'})`,
              { ttl: 0, sticky: true }
            );
          } catch (_) {}
        }
        if (opts.pollFallback) startFallbackPolling(opts.pollFallback);
      }, offlineThreshold);
    });

    socket.io.on('reconnect_failed', () => {
      setState('offline');
      try {
        window.RobotrendToast?.error(
          'Falha de reconexão',
          'Continuamos servindo dados via REST a cada poucos segundos.',
          { ttl: 0, sticky: true }
        );
      } catch (_) {}
      if (opts.pollFallback) startFallbackPolling(opts.pollFallback);
    });
  }

  window.RobotrendConnection = {
    attach,
    get state()      { return state.state; },
    get reconnects() { return state.reconnects; },
    get snapshot()   { return { ...state, socket: undefined }; },
  };
})();
