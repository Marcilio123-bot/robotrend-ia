/* ============================================================
   ROBOTREND IA — Realtime Heartbeat
   ------------------------------------------------------------
   Pulso central que rastreia "saúde" da camada realtime:

     - Socket.io     → estado (online/pending/offline) + última atividade
     - REST polling  → último endpoint + timestamp da última resposta

   Renderiza em qualquer elemento marcado com [data-heartbeat]:
     <span data-heartbeat></span>

   Outros módulos avisam o heartbeat via window.RobotrendHeartbeat:
     RobotrendHeartbeat.markSocketState('online' | 'pending' | 'offline');
     RobotrendHeartbeat.markSocketActivity('matches:update');
     RobotrendHeartbeat.markRestActivity('/api/football/live');

   O componente faz auto-refresh do "há X segundos" a cada 1s.
   ============================================================ */
(function () {
  'use strict';

  const state = {
    socket: {
      state: 'pending',          // 'online' | 'pending' | 'offline'
      lastEvent: null,
      lastEventAt: null,
      connectedAt: null,
    },
    rest: {
      lastEndpoint: null,
      lastAt: null,
      lastStatus: null,
    },
  };

  const hosts = new Set();
  const listeners = new Set();

  function notify() {
    for (const fn of listeners) {
      try { fn(state); } catch (_) {}
    }
    for (const host of hosts) renderHost(host);
  }

  /* ============================================================
     PUBLIC API
     ============================================================ */
  const api = {
    state,

    markSocketState(next) {
      const norm = next === 'online' || next === 'pending' || next === 'offline'
        ? next
        : 'pending';
      if (state.socket.state === norm) return;
      state.socket.state = norm;
      if (norm === 'online' && !state.socket.connectedAt) {
        state.socket.connectedAt = Date.now();
      }
      if (norm !== 'online') {
        state.socket.connectedAt = null;
      }
      notify();
    },

    markSocketActivity(event) {
      state.socket.lastEvent = event || 'unknown';
      state.socket.lastEventAt = Date.now();
      // Atividade implica online. Não força state se já está marcado online.
      if (state.socket.state !== 'online') {
        state.socket.state = 'online';
        if (!state.socket.connectedAt) state.socket.connectedAt = Date.now();
      }
      notify();
    },

    markRestActivity(endpoint, status) {
      state.rest.lastEndpoint = endpoint || null;
      state.rest.lastAt = Date.now();
      state.rest.lastStatus = status == null ? 200 : Number(status);
      notify();
    },

    mount(host) {
      if (!host) return;
      hosts.add(host);
      renderHost(host);
    },

    unmount(host) { hosts.delete(host); },

    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };

  /* ============================================================
     RENDER
     ============================================================ */
  function fmtRelative(ts) {
    if (!ts) return '—';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 5)   return 'agora';
    if (s < 60)  return `há ${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60)  return `há ${m}min`;
    const h = Math.floor(m / 60);
    return `há ${h}h`;
  }

  function socketLabel(s) {
    return ({ online: 'ao vivo', pending: 'reconectando', offline: 'offline' }[s.state] || s.state);
  }

  function socketKind(s) {
    return ({ online: 'ok', pending: 'warn', offline: 'err' }[s.state] || '');
  }

  function renderHost(host) {
    const compact = host.hasAttribute('data-heartbeat-compact');
    const socketStr = `${socketLabel(state.socket)} · ${fmtRelative(state.socket.lastEventAt)}`;
    const restStr   = state.rest.lastAt
      ? `REST ${fmtRelative(state.rest.lastAt)}`
      : 'REST aguardando';

    if (compact) {
      host.className = `heartbeat heartbeat-compact heartbeat-${socketKind(state.socket)}`;
      host.innerHTML = `
        <span class="heartbeat-dot" aria-hidden="true"></span>
        <span class="heartbeat-text">${socketStr}</span>
      `;
      host.title = `${socketStr} · ${restStr}`;
      return;
    }

    host.className = `heartbeat heartbeat-${socketKind(state.socket)}`;
    host.innerHTML = `
      <span class="heartbeat-dot" aria-hidden="true"></span>
      <span class="heartbeat-block">
        <span class="heartbeat-label">Socket</span>
        <span class="heartbeat-value">${socketStr}</span>
      </span>
      <span class="heartbeat-sep" aria-hidden="true">·</span>
      <span class="heartbeat-block">
        <span class="heartbeat-label">REST</span>
        <span class="heartbeat-value">${restStr}${state.rest.lastEndpoint ? `<span class="heartbeat-endpoint">${state.rest.lastEndpoint}</span>` : ''}</span>
      </span>
    `;
  }

  /* ============================================================
     AUTO-MOUNT + TICKER
     ============================================================ */
  function autoMount() {
    document.querySelectorAll('[data-heartbeat]').forEach((el) => api.mount(el));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoMount);
  } else {
    autoMount();
  }

  // Tick a cada 1s para atualizar "há X segundos" sem precisar de novo evento.
  setInterval(() => { for (const host of hosts) renderHost(host); }, 1000);

  window.RobotrendHeartbeat = api;
})();
