/* ============================================================
   ROBOTREND IA — Lazy Loader
   ------------------------------------------------------------
   Carrega scripts e executa callbacks somente quando necessário:

     RobotrendLazy.script(src)               → Promise<HTMLScriptElement>
     RobotrendLazy.onVisible(el, cb, opts)   → roda cb quando el entra no viewport
     RobotrendLazy.whenIdle(cb, timeout)     → requestIdleCallback wrapper
     RobotrendLazy.scriptOnVisible(el, src)  → carrega script só quando el visível

   Comportamento:
     - script() é idempotente (cache por src)
     - onVisible usa IntersectionObserver com fallback síncrono
     - whenIdle usa rIC com fallback setTimeout

   Uso típico:
     RobotrendLazy.scriptOnVisible(host, '/widgets/sparkline.js');
   ============================================================ */
(function () {
  'use strict';

  if (window.RobotrendLazy) return;

  const cache = new Map(); // src -> Promise

  /**
   * Aplica cache busting nos scripts carregados sob demanda, usando o selo
   * window.__ASSET_VERSION__ injetado pelo servidor no HTML. Mantém a mesma
   * política dos <script> estáticos: cada deploy → URL nova → download fresco.
   */
  function versioned(src) {
    try {
      if (!src || src.charAt(0) !== '/') return src; // só assets locais root-relative
      if (/[?&]v=/.test(src)) return src;            // já versionado
      const v = window.__ASSET_VERSION__;
      if (!v) return src;
      return src + (src.indexOf('?') >= 0 ? '&' : '?') + 'v=' + encodeURIComponent(v);
    } catch (_) {
      return src;
    }
  }

  function script(src, attrs = {}) {
    if (cache.has(src)) return cache.get(src);
    const finalSrc = versioned(src);
    const p = new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${finalSrc}"]`);
      if (existing) return resolve(existing);
      const s = document.createElement('script');
      s.src = finalSrc;
      s.defer = true;
      Object.entries(attrs).forEach(([k, v]) => s.setAttribute(k, v));
      s.onload = () => resolve(s);
      s.onerror = (e) => { cache.delete(src); reject(new Error(`failed to load ${src}`)); };
      document.head.appendChild(s);
    });
    cache.set(src, p);
    return p;
  }

  function onVisible(el, cb, opts = {}) {
    if (!el) return () => {};
    if (!('IntersectionObserver' in window)) {
      // fallback: roda imediatamente
      try { cb(el); } catch (e) { console.warn('[RobotrendLazy onVisible]', e); }
      return () => {};
    }
    const obs = new IntersectionObserver((entries, o) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          try { cb(entry.target); } catch (e) { console.warn('[RobotrendLazy onVisible cb]', e); }
          if (opts.once !== false) o.unobserve(entry.target);
        }
      }
    }, {
      root: opts.root || null,
      rootMargin: opts.rootMargin || '120px 0px',
      threshold: opts.threshold ?? 0.05,
    });
    obs.observe(el);
    return () => obs.disconnect();
  }

  function scriptOnVisible(el, src, attrs) {
    return new Promise((resolve, reject) => {
      onVisible(el, () => {
        script(src, attrs).then(resolve).catch(reject);
      }, { once: true });
    });
  }

  function whenIdle(cb, timeout = 1500) {
    if ('requestIdleCallback' in window) {
      return window.requestIdleCallback(cb, { timeout });
    }
    return setTimeout(cb, Math.min(150, timeout));
  }

  /**
   * Carrega múltiplos scripts em sequência (preserva ordem).
   * Útil quando B depende de A.
   */
  async function scriptSequence(srcs) {
    for (const s of srcs) await script(s);
  }

  window.RobotrendLazy = { script, onVisible, scriptOnVisible, whenIdle, scriptSequence };
})();
