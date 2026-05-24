/* Robotrend IA — registro PWA + install prompt */
(function () {
  'use strict';

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('/service-worker.js', { updateViaCache: 'none' })
        .then((reg) => {
          console.log('[pwa] SW registrado:', reg.scope);
          // Verifica updates imediatamente — fundamental quando bumpamos
          // a versão do SW para invalidar caches antigos de HTML.
          reg.update().catch(() => {});
          // Quando um novo SW for instalado, força a ativação dele
          // sem aguardar reload manual (fix definitivo de cache stale).
          reg.addEventListener('updatefound', () => {
            const sw = reg.installing;
            if (!sw) return;
            sw.addEventListener('statechange', () => {
              if (sw.state === 'installed' && navigator.serviceWorker.controller) {
                sw.postMessage('SKIP_WAITING');
              }
            });
          });
        })
        .catch((err) => console.warn('[pwa] SW falha:', err));

      // Quando o controller mudar (novo SW ativou), recarrega 1x
      // para garantir que a página vem fresca via novo SW (network-only).
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloading) return;
        reloading = true;
        location.reload();
      });
    });
  }

  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    window.dispatchEvent(new CustomEvent('robotrend:installable'));
  });

  window.Robotrend = window.Robotrend || {};
  window.Robotrend.installApp = async function () {
    if (!deferredPrompt) return false;
    deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    deferredPrompt = null;
    return choice.outcome === 'accepted';
  };
})();
