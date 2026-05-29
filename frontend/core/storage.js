/* ============================================================
   ROBOTREND IA — Persisted Storage
   ------------------------------------------------------------
   Wrapper sobre localStorage com:
     - namespace automático ('robotrend.' prefix)
     - serialização JSON com fallback graceful
     - quota guard (descarta silenciosamente se localStorage estourar)
     - watch() — observa mudanças (mesma aba + outras abas via 'storage' event)
     - default value injetável

   API:
     RobotrendStorage.get(key, fallback)
     RobotrendStorage.set(key, value)
     RobotrendStorage.remove(key)
     RobotrendStorage.watch(key, cb)         → desinscreve via retorno
     RobotrendStorage.has(key)
     RobotrendStorage.keys()                 → lista das chaves do namespace
   ============================================================ */
(function () {
  'use strict';

  if (window.RobotrendStorage) return;

  const NS = 'robotrend.';
  const watchers = new Map(); // key -> Set<cb>

  function safe(fn, fallback) {
    try { return fn(); } catch { return fallback; }
  }

  function get(key, fallback) {
    return safe(() => {
      const raw = localStorage.getItem(NS + key);
      if (raw == null) return fallback;
      return JSON.parse(raw);
    }, fallback);
  }

  function set(key, value) {
    return safe(() => {
      localStorage.setItem(NS + key, JSON.stringify(value));
      notify(key, value);
      return true;
    }, false);
  }

  function remove(key) {
    return safe(() => {
      localStorage.removeItem(NS + key);
      notify(key, null);
      return true;
    }, false);
  }

  function has(key) {
    return safe(() => localStorage.getItem(NS + key) != null, false);
  }

  function keys() {
    return safe(() => {
      const out = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(NS)) out.push(k.slice(NS.length));
      }
      return out;
    }, []);
  }

  function watch(key, cb) {
    if (typeof cb !== 'function') return () => {};
    let set = watchers.get(key);
    if (!set) { set = new Set(); watchers.set(key, set); }
    set.add(cb);
    return () => set.delete(cb);
  }

  function notify(key, value) {
    const set = watchers.get(key);
    if (!set) return;
    for (const cb of set) {
      try { cb(value); } catch (e) { console.warn('[RobotrendStorage watch]', key, e); }
    }
  }

  // Sincronização entre abas
  window.addEventListener('storage', (ev) => {
    if (!ev.key?.startsWith(NS)) return;
    const k = ev.key.slice(NS.length);
    const v = safe(() => ev.newValue ? JSON.parse(ev.newValue) : null, null);
    notify(k, v);
  });

  window.RobotrendStorage = { get, set, remove, has, keys, watch, NS };
})();
