/* ============================================================
   ROBOTREND IA — Master Layout
   ------------------------------------------------------------
   Aplica a "casca" das páginas MASTER ADMIN. Responsabilidades:

     1. GUARD imediato (anti-flash):
        Se o cache local diz que o user NÃO é master, redireciona
        ANTES da página renderizar.

     2. Header MASTER ADMIN:
        Insere uma barra superior com selo, heartbeat realtime e
        indicadores de sistema online.

     3. Hooks de widgets master:
        Permite que páginas master montem o widget de status
        operacional declarando <div data-ops-status></div>.

     4. Marca o <body> como saas-mode-master para CSS contextual.

   IMPORTANTE:
     - O guard usa apenas dados do cache (auth.js / user-state).
       Ele NÃO faz fetch ao backend. O auth-guard.js continua sendo
       a verdade final via /api/auth/me — este layout só elimina
       o flash visual entre o load e o /me retornar.
   ============================================================ */
(function () {
  'use strict';

  const MASTER_ROLES = new Set(['master', 'admin', 'owner', 'super_admin']);
  const HOME = '/index.html';

  function getCachedUser() {
    try {
      const us = window.RobotrendUser?.get?.();
      if (us?.user) return { ...us.user, role: us.role, isAdmin: us.isAdmin };
      return window.RobotrendAuth?.getUser?.() || null;
    } catch { return null; }
  }

  function isMasterRole(u) {
    if (!u) return false;
    if (u.isAdmin === true) return true;
    const r = String(u.role || '').toLowerCase();
    return MASTER_ROLES.has(r);
  }

  function shouldGuard() {
    // Páginas master se identificam pela meta robotrend-guard="admin",
    // pelo path /admin|/ops ou por opt-in explícito via meta robotrend-layout="master".
    const guardMeta = document.querySelector('meta[name="robotrend-guard"]');
    if (guardMeta?.content?.toLowerCase() === 'admin') return true;
    const layoutMeta = document.querySelector('meta[name="robotrend-layout"]');
    if (layoutMeta?.content?.toLowerCase() === 'master') return true;
    return /^\/(admin|ops)(\/|$|\.html?$)/i.test(location.pathname);
  }

  /* ============================================================
     GUARD CLIENT-SIDE — anti-flash visual
     ============================================================ */
  function runGuard() {
    if (!shouldGuard()) return true;
    const u = getCachedUser();
    if (!u) {
      // Não há cache: deixamos o auth-guard.js (com meta robotrend-guard=admin)
      // resolver via /api/auth/me. Ele já esconde o body durante a checagem.
      return true;
    }
    if (!isMasterRole(u)) {
      // Esconde o body imediatamente e redireciona — zero flash.
      try {
        const style = document.createElement('style');
        style.textContent = 'body{visibility:hidden!important;background:#07100a;}';
        document.head.appendChild(style);
      } catch (_) {}
      location.replace(`${HOME}?denied=${encodeURIComponent(location.pathname)}`);
      return false;
    }
    return true;
  }

  // Roda guard ANTES de qualquer DOM ready, sincronamente.
  if (!runGuard()) return;

  /**
   * IMPORTANTE — separação total client/master:
   *   - Este layout SÓ ativa init() em páginas master (declaradas via
   *     meta robotrend-guard="admin", meta robotrend-layout="master" OU
   *     path /admin* | /ops*). Em páginas cliente o script carrega mas
   *     fica inerte — sem aplicar saas-mode-master, sem mountar topbar,
   *     sem carregar ops-status.
   *   - Quem identifica páginas master é shouldGuard(); reusamos.
   *   - Antes desse gate, o master-topbar e o body class apareciam em
   *     /index.html (cliente) quando o user era admin, causando a
   *     duplicação visual com a sidebar do saas-nav.
   */
  const IS_MASTER_PAGE = shouldGuard();

  /* ============================================================
     BODY MODE
     ============================================================ */
  function applyBodyMode() {
    document.body.classList.remove('saas-mode-client');
    document.body.classList.add('saas-mode-master');
  }

  /* ============================================================
     MASTER HEADER BAR
     ------------------------------------------------------------
     Renderiza uma barra superior dentro do .saas-content (se existir),
     antes de qualquer .saas-page-header. Em páginas que já tem header
     próprio, o master bar fica acima — sem conflito visual.
     ============================================================ */
  function mountMasterBar() {
    if (document.querySelector('.master-topbar')) return;
    const content = document.querySelector('.saas-content');
    if (!content) return;

    const bar = document.createElement('div');
    bar.className = 'master-topbar';
    bar.innerHTML = `
      <div class="master-topbar-left">
        <span class="master-topbar-badge">
          <span class="master-topbar-badge-dot" aria-hidden="true"></span>
          MASTER ADMIN
        </span>
        <span class="master-topbar-section" id="master-topbar-page"></span>
      </div>
      <div class="master-topbar-right">
        <span class="master-topbar-pill" id="master-topbar-online" title="Sistema online">
          <span class="master-topbar-pill-dot" aria-hidden="true"></span>
          sistema online
        </span>
        <span data-heartbeat data-heartbeat-compact></span>
      </div>
    `;
    content.insertBefore(bar, content.firstChild);

    const pageEl = bar.querySelector('#master-topbar-page');
    if (pageEl) {
      const h1 = document.querySelector('.saas-page-title');
      if (h1) pageEl.textContent = h1.textContent.replace(/^[\W_]+/, '').trim();
    }

    const heartbeat = bar.querySelector('[data-heartbeat]');
    if (heartbeat && window.RobotrendHeartbeat?.mount) {
      window.RobotrendHeartbeat.mount(heartbeat);
    }
  }

  /* ============================================================
     OPS STATUS HOOK — lazy load: carrega o widget apenas quando
     [data-ops-status] entra no viewport. Reduz custo em páginas
     onde a seção fica abaixo do fold.

     Carrega também (em paralelo, on-visible) o widgets/sparkline.js,
     dependência do widget de ops.
     ============================================================ */
  function ensureOpsWidget() {
    const host = document.querySelector('[data-ops-status]');
    if (!host) return;
    if (!window.RobotrendLazy?.onVisible) {
      // fallback: carrega imediatamente
      window.RobotrendLazy?.script?.('/widgets/sparkline.js');
      window.RobotrendLazy?.script?.('/admin/ops-status.js');
      return;
    }
    window.RobotrendLazy.onVisible(host, () => {
      // Carrega em sequência: sparkline primeiro (dependência do widget),
      // depois ops-status. Garante que o primeiro paint já consiga renderizar
      // os mini gráficos.
      window.RobotrendLazy.scriptSequence([
        '/widgets/sparkline.js',
        '/admin/ops-status.js',
      ]).catch((e) => console.warn('[master-layout] ops widget load failed', e));
    }, { rootMargin: '200px 0px' });
  }

  /* ============================================================
     INIT — só roda em páginas master, evitando duplicação visual
     com o saas-nav.js em /index.html, /signals.html, etc.
     ============================================================ */
  function init() {
    if (!IS_MASTER_PAGE) return;
    applyBodyMode();
    mountMasterBar();
    ensureOpsWidget();
  }

  if (IS_MASTER_PAGE) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }

    // Re-aplica modo quando a role do user é confirmada (ex: depois do /me).
    // Sai de fininho se o user confirmado NÃO for master — auth-guard já
    // está redirecionando, mas duplicamos a defesa.
    window.addEventListener('robotrend:user-ready', (ev) => {
      const role = ev.detail?.role;
      if (role && !MASTER_ROLES.has(String(role).toLowerCase())) {
        location.replace(HOME);
        return;
      }
      applyBodyMode();
    });
  }

  window.RobotrendMasterLayout = {
    init, isMasterRole, getCachedUser,
    isMasterPage: () => IS_MASTER_PAGE,
  };
})();
