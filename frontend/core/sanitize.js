/* ============================================================
   ROBOTREND IA — Sanitize helpers
   ------------------------------------------------------------
   Defesa contra XSS em strings vindas de payload socket/REST.
   API:
     RobotrendSanitize.escapeHtml(str)
     RobotrendSanitize.escapeAttr(str)
     RobotrendSanitize.safeJson(str, fallback)
     RobotrendSanitize.guard(fn, fallback)
       → wrappa fn() em try/catch e devolve fallback se exceção.
   ============================================================ */
(function () {
  'use strict';

  if (window.RobotrendSanitize) return;

  const HTML_MAP = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' };
  const ATTR_MAP = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;', '`':'&#96;', '=':'&#61;' };

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, (c) => HTML_MAP[c]);
  }

  function escapeAttr(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"'`=]/g, (c) => ATTR_MAP[c]);
  }

  function safeJson(input, fallback) {
    if (input == null) return fallback;
    if (typeof input === 'object') return input;
    try { return JSON.parse(input); } catch { return fallback; }
  }

  /**
   * Garante que o callback nunca quebre o callsite. Útil para handlers
   * de socket/event bus onde uma exceção pararia o pipeline inteiro.
   */
  function guard(fn, fallback) {
    return function guarded(...args) {
      try { return fn(...args); }
      catch (err) {
        console.warn('[RobotrendSanitize.guard]', err?.message || err);
        try { window.RobotrendBus?.emit('robotrend:exception', { err: String(err), at: Date.now() }); } catch (_) {}
        return fallback;
      }
    };
  }

  /**
   * Limpa um payload de socket retornando apenas o subset whitelist.
   * Útil para defesa contra mensagens malformadas:
   *   const safe = RobotrendSanitize.pick(payload, ['id','home','away','minute']);
   */
  function pick(payload, keys) {
    if (!payload || typeof payload !== 'object') return {};
    const out = {};
    for (const k of keys || []) {
      if (k in payload) out[k] = payload[k];
    }
    return out;
  }

  window.RobotrendSanitize = { escapeHtml, escapeAttr, safeJson, guard, pick };
})();
