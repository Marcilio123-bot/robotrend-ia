/* ============================================================
   ROBOTREND IA — User State (estado central do usuário)
   ------------------------------------------------------------
   Fonte canônica do estado do user/plan/access para TODAS as
   páginas. Resolve 3 problemas:

     1. CACHE LOCAL — render imediato sem flash
     2. SERVER TRUTH — refresh via /api/me/subscription
     3. POLLING ADAPTATIVO — após o user clicar "Virar Premium",
        ativa polling a cada 10s até detectar PREMIUM
        (fallback se socket cair / outra aba pagou)

   USO:
     // Acessar
     const u = RobotrendUser.get();
     if (RobotrendUser.isPremium()) { ... }
     if (RobotrendUser.can('bestSignal')) { ... }

     // Reagir a mudanças
     RobotrendUser.onChange((user, prev) => {
       if (user.isPremium && !prev?.isPremium) {
         showCelebration();
       }
     });

     // Forçar refresh agora
     await RobotrendUser.refresh();

     // Ligar polling (chamado pelo virarPremium antes do redirect)
     RobotrendUser.startUpgradePolling();

   IMPORTANTE: este módulo NUNCA modifica role/plan no servidor.
   Apenas consulta /api/me/subscription e sincroniza a UI.
   ============================================================ */
(function () {
  'use strict';

  const POLLING_FAST_MS    = 10_000;   // 10s — polling após clicar upgrade
  const POLLING_IDLE_MS    = 60_000;   // 60s — sanity check normal
  const UPGRADE_TIMEOUT_MS = 30 * 60 * 1000; // desiste após 30min
  const LS_PENDING_KEY     = 'robotrend_pending_upgrade';
  const LS_USER_CACHE_KEY  = 'robotrend_user_subscription_v1';

  let state = null;        // último user retornado pelo server
  let prevState = null;
  let inflight = null;     // promise de refresh em curso (dedupe)
  let pollingTimer = null;
  let pollingMode = 'idle'; // 'idle' | 'fast'
  const listeners = new Set();

  // ============ helpers ============

  function readCache() {
    try {
      const raw = localStorage.getItem(LS_USER_CACHE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) { return null; }
  }
  function writeCache(s) {
    try { localStorage.setItem(LS_USER_CACHE_KEY, JSON.stringify(s)); } catch (_) {}
  }
  function clearCache() {
    try { localStorage.removeItem(LS_USER_CACHE_KEY); } catch (_) {}
  }

  function readPending() {
    try {
      const raw = localStorage.getItem(LS_PENDING_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw);
      if (Date.now() - (p?.startedAt || 0) > UPGRADE_TIMEOUT_MS) {
        clearPending();
        return null;
      }
      return p;
    } catch (_) { return null; }
  }
  function setPending(plan) {
    try {
      localStorage.setItem(LS_PENDING_KEY, JSON.stringify({
        plan: plan || 'PREMIUM',
        startedAt: Date.now(),
      }));
    } catch (_) {}
  }
  function clearPending() {
    try { localStorage.removeItem(LS_PENDING_KEY); } catch (_) {}
  }

  function notify() {
    for (const cb of listeners) {
      try { cb(state, prevState); } catch (err) { console.warn('[user-state] listener err', err); }
    }
  }

  function applyState(next) {
    prevState = state;
    state = next;
    if (next) writeCache(next);
    // Detecta upgrade automático
    if (next?.isPremium && (!prevState || !prevState.isPremium)) {
      clearPending();
      stopUpgradePolling();
      window.dispatchEvent(new CustomEvent('robotrend:upgrade-detected', { detail: next }));
    }
    notify();
  }

  // ============ refresh do server ============

  async function refresh(opts = {}) {
    if (inflight && !opts.force) return inflight;
    if (!window.RobotrendAuth?.getToken?.()) {
      applyState(null);
      return null;
    }
    inflight = (async () => {
      try {
        const data = await window.RobotrendAuth.api('/api/me/subscription');
        applyState(normalizeServerData(data));
        return state;
      } catch (err) {
        // 401 → token inválido; chama clearSession se disponível
        if (err?.status === 401) {
          window.RobotrendAuth?.clearSession?.();
          applyState(null);
        } else {
          console.warn('[user-state] refresh falhou:', err?.message);
        }
        return null;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  function normalizeServerData(d) {
    if (!d) return null;
    return {
      user: d.user || null,
      plan: d.plan || 'FREE',
      planLabel: d.planLabel || 'Free',
      planPriceBRL: d.planPriceBRL || 0,
      role: d.role || 'user',
      isPremium: !!d.isPremium,
      isAdmin: !!d.isAdmin,
      access: d.access || {},
      subscription: d.subscription || null,
      paymentHistory: d.paymentHistory || [],
      features: d.features || {},
      dailySignalsLimit: d.dailySignalsLimit || 0,
      serverTime: d.serverTime || new Date().toISOString(),
      _localTime: Date.now(),
    };
  }

  // ============ polling adaptativo ============

  function schedulePolling(intervalMs) {
    if (pollingTimer) clearInterval(pollingTimer);
    pollingTimer = setInterval(() => {
      // Pausa polling quando aba escondida (poupa quota)
      if (document.visibilityState === 'hidden') return;
      refresh({ force: false }).then((s) => {
        if (s?.isPremium && pollingMode === 'fast') {
          stopUpgradePolling();
        }
      });
    }, intervalMs);
  }

  function startUpgradePolling() {
    pollingMode = 'fast';
    setPending(state?.plan || 'PREMIUM');
    schedulePolling(POLLING_FAST_MS);
    console.info('[user-state] polling rápido iniciado (10s) — aguardando upgrade');
  }

  function stopUpgradePolling() {
    if (pollingMode === 'fast') {
      console.info('[user-state] polling rápido finalizado');
    }
    pollingMode = 'idle';
    clearPending();
    schedulePolling(POLLING_IDLE_MS);
  }

  // ============ socket listener ============

  function attachSocketListener() {
    // Reage quando o socket global emitir 'user:upgraded' (vindo do webhook).
    // O dashboard.js já tem o listener específico; aqui é um catch-all.
    window.addEventListener('robotrend:user-upgraded-event', () => {
      refresh({ force: true });
    });

    // Listener pra "robotrend:user-ready" do auth-guard
    window.addEventListener('robotrend:user-ready', () => {
      refresh({ force: false });
    });

    // Recarrega quando a aba volta a ficar visível
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        // Sempre verifica se houve mudança quando a aba retorna
        refresh({ force: false });
      }
    });

    // BroadcastChannel — sincroniza entre abas
    try {
      const bc = new BroadcastChannel('robotrend-user');
      bc.addEventListener('message', (ev) => {
        if (ev.data === 'refresh') refresh({ force: true });
      });
      window.__robotrend_bc = bc;
    } catch (_) {}
  }

  function broadcast(msg) {
    try { window.__robotrend_bc?.postMessage(msg); } catch (_) {}
  }

  // ============ API pública ============

  const RobotrendUser = {
    get: () => state,
    isPremium: () => !!state?.isPremium,
    isAdmin: () => !!state?.isAdmin,
    isFree: () => state ? (!state.isPremium && !state.isAdmin) : false,
    can: (key) => !!(state?.access?.[key]),
    plan: () => state?.plan || 'FREE',
    role: () => state?.role || 'user',
    user: () => state?.user || null,

    /** Subscribe a mudanças de estado. Retorna unsubscribe. */
    onChange: (cb) => {
      listeners.add(cb);
      // Dispara imediatamente com o estado atual
      if (state) { try { cb(state, null); } catch (_) {} }
      return () => listeners.delete(cb);
    },

    /** Força refresh do server agora. */
    refresh: (opts) => refresh(opts || {}),

    /** Liga polling rápido (10s) — chamado por virarPremium() antes do redirect. */
    startUpgradePolling,
    stopUpgradePolling,

    /** Indica se há um checkout em curso (set pelo virarPremium). */
    hasPendingUpgrade: () => !!readPending(),
    pendingUpgrade: () => readPending(),
    clearPending,

    /** Notifica outras abas. Use após detectar upgrade. */
    broadcastRefresh: () => broadcast('refresh'),

    _state: () => state, // debug
  };

  window.RobotrendUser = RobotrendUser;

  // ============ boot ============

  // 1) cache local imediato (sem flash)
  const cached = readCache();
  if (cached) {
    state = cached;
    notify();
  }

  // 2) attach socket/visibility listeners
  attachSocketListener();

  // 3) decide modo de polling com base em "checkout pendente"
  const pending = readPending();
  if (pending) {
    console.info('[user-state] upgrade pendente detectado — polling rápido');
    pollingMode = 'fast';
    schedulePolling(POLLING_FAST_MS);
  } else {
    schedulePolling(POLLING_IDLE_MS);
  }

  // 4) primeiro refresh do server (apenas se houver token)
  if (window.RobotrendAuth?.getToken?.()) {
    refresh({ force: true });
  }
})();
