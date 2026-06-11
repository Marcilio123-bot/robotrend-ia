/* ============================================================
   ROBOTREND IA — Rastreador de Analytics (cliente)
   ------------------------------------------------------------
   Reporta automaticamente eventos de uso para o backend:
     · RobotrendTrack.signal(id|ids)  → sinais visualizados
     · RobotrendTrack.game(id|ids)    → jogos analisados

   Deduplicação por SESSÃO: cada id só conta uma vez (por aba),
   evitando inflar contadores quando a página faz polling.
   Os eventos são agrupados (debounce) e enviados em lote para
   POST /api/analytics/track.
   ============================================================ */
(function (global) {
  'use strict';

  const seen = {
    signal_view: new Set(),
    game_analysis: new Set(),
  };
  const pending = {
    signal_view: 0,
    game_analysis: 0,
  };
  let flushTimer = null;

  function token() {
    try { return global.RobotrendAuth?.getToken?.() || ''; } catch { return ''; }
  }

  async function send(type, count) {
    if (!count) return;
    try {
      await fetch('/api/analytics/track', {
        method: 'POST',
        credentials: 'include',
        headers: Object.assign(
          { 'Content-Type': 'application/json' },
          token() ? { Authorization: `Bearer ${token()}` } : {}
        ),
        body: JSON.stringify({ type, count }),
        keepalive: true,
      });
    } catch (_) { /* analytics nunca quebra a UX */ }
  }

  function flush() {
    flushTimer = null;
    for (const type of Object.keys(pending)) {
      const n = pending[type];
      if (n > 0) {
        pending[type] = 0;
        send(type, n);
      }
    }
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, 1200);
  }

  /** Registra ids de um tipo, ignorando os já vistos nesta sessão. */
  function record(type, ids) {
    if (!token()) return; // só rastreia usuário autenticado
    const list = Array.isArray(ids) ? ids : [ids];
    let added = 0;
    for (const raw of list) {
      if (raw == null || raw === '') continue;
      const key = String(raw);
      if (seen[type].has(key)) continue;
      seen[type].add(key);
      added++;
    }
    if (added > 0) {
      pending[type] += added;
      scheduleFlush();
    }
  }

  // Garante o envio do que ficou pendente ao sair/ocultar a página.
  global.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });

  global.RobotrendTrack = {
    signal: (ids) => record('signal_view', ids),
    game: (ids) => record('game_analysis', ids),
  };
})(window);
