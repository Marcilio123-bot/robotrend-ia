/* ============================================================
   ROBOTREND IA — Client Layout
   ------------------------------------------------------------
   Aplica a "casca" das páginas do CLIENTE (FREE / PREMIUM / VIP).
   Responsabilidades:

     - garantir que o body fique no modo correto (saas-mode-client)
     - montar o heartbeat realtime no header (se houver mount point)
     - posicionar widgets/atalhos exclusivos do cliente
     - oferecer fallback amigável caso saas-nav ainda não tenha bootado

   NÃO se preocupa com a montagem da sidebar — isso é responsabilidade
   do saas-nav.js. Este layout adiciona EXTRAS à página.

   Auto-detecta o perfil via window.RobotrendNav.pickNav (que respeita
   ?asClient=1, role, e path). Em páginas master, este layout não faz
   nada — quem assume é o master-layout.js.
   ============================================================ */
(function () {
  'use strict';

  function getUser() {
    try {
      const us = window.RobotrendUser?.get?.();
      if (us) return { ...us.user, role: us.role, plan: us.plan, isAdmin: us.isAdmin, isPremium: us.isPremium };
      return window.RobotrendAuth?.getUser?.() || null;
    } catch { return null; }
  }

  function detectKind() {
    if (window.RobotrendNav?.pickNav) {
      return window.RobotrendNav.pickNav(getUser()).kind;
    }
    // Fallback heurístico se saas-nav ainda não carregou.
    if (location.search.includes('asClient=1')) return 'client';
    if (/^\/(admin|ops)(\/|$|\.html?$)/i.test(location.pathname)) return 'master';
    return 'client';
  }

  function applyBodyMode() {
    if (detectKind() !== 'client') return;
    document.body.classList.remove('saas-mode-master');
    document.body.classList.add('saas-mode-client');
  }

  function mountHeartbeat() {
    if (detectKind() !== 'client') return;
    // Procura por mount point já existente; se não existir, injeta um pill
    // discreto ao lado do ws-status na header.
    const existing = document.querySelector('[data-heartbeat]');
    if (existing) return;

    const wsPill = document.getElementById('ws-status');
    if (!wsPill) return;
    const span = document.createElement('span');
    span.setAttribute('data-heartbeat', '');
    span.setAttribute('data-heartbeat-compact', '');
    wsPill.parentElement?.insertBefore(span, wsPill.nextSibling);
    window.RobotrendHeartbeat?.mount(span);
  }

  function init() {
    applyBodyMode();
    mountHeartbeat();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Reage quando o user-state confirma a role (ex: passou de cliente
  // para premium após webhook MP) — re-checa o kind.
  window.addEventListener('robotrend:user-ready', applyBodyMode);
  window.addEventListener('robotrend:upgrade-detected', applyBodyMode);

  window.RobotrendClientLayout = { init, detectKind };
})();
