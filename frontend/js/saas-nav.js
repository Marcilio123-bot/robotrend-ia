/* ============================================================
   ROBOTREND IA — SaaS Navigation (sidebar compartilhada)
   ------------------------------------------------------------
   DOIS MENUS COMPLETAMENTE SEPARADOS:

     clientNav  → usuário FREE / PREMIUM (sidebar comercial)
     masterNav  → administrador da plataforma (sidebar operacional)

   REGRA DE ESCOLHA — PATH-BASED (anti-duplicação):
     1) path ∈ /admin|/ops              → masterNav  (kind=master)
        (o auth-guard já bloqueou acesso pra não-master antes deste ponto)
     2) ?asClient=1                     → clientNav  (kind=client)
        (preview opcional, sobrescreve o cliente padrão)
     3) qualquer outra rota             → clientNav  (kind=client)

   Antes desta regra, masters em /index.html viam masterNav lá dentro,
   misturando UI cliente com sidebar master. Agora a sidebar segue
   estritamente a URL. Para masters acessarem o painel admin a partir
   do client sidebar, injetamos um atalho "→ Painel Master" SOMENTE
   quando o user logado tem role master/admin/owner.

   Uso: <div id="saas-nav" data-active="dashboard"></div>
        <script src="/js/saas-nav.js"></script>
   ============================================================ */
(function () {
  'use strict';

  /** Roles consideradas master-level (alinhado com backend/auth.js). */
  const MASTER_ROLES = new Set(['master', 'admin', 'owner', 'super_admin']);

  /* ============================================================
     CLIENT NAV — sidebar do produto SaaS (FREE/PREMIUM/VIP)
     ============================================================ */
  const clientNav = [
    {
      section: 'Painel',
      items: [
        { id: 'dashboard',  label: 'Dashboard',        icon: '◧', href: '/index.html' },
        { id: 'signals',    label: 'Sinais',           icon: '◆', href: '/signals.html', badge: 'live' },
        { id: 'football',   label: 'Jogos ao vivo',    icon: '⚽', href: '/football.html' },
        { id: 'analytics',  label: 'Analytics',        icon: '▲', href: '/analytics.html' },
      ],
    },
    {
      section: 'Performance',
      items: [
        { id: 'results',    label: 'Resultados',       icon: '$', href: '/results.html' },
        { id: 'quality',    label: 'Qualidade IA',     icon: '◊', href: '/quality.html' },
      ],
    },
    {
      section: 'Conta',
      items: [
        { id: 'account',    label: 'Minha Assinatura', icon: '◆', href: '/account.html' },
      ],
    },
  ];

  /* ============================================================
     MASTER NAV — sidebar exclusiva do administrador da plataforma
     NÃO inclui "Minha Assinatura" (master não é cliente)
     NÃO inclui CTA de upgrade
     ============================================================ */
  const masterNav = [
    {
      section: 'Master Admin',
      items: [
        { id: 'admin',          label: 'Painel Master',  icon: '◉', href: '/admin' },
        { id: 'admin-users',    label: 'Usuários',       icon: '◇', href: '/admin/users' },
        { id: 'admin-finance',  label: 'Financeiro',     icon: '◈', href: '/admin/finance' },
        { id: 'admin-system',   label: 'Sistema',        icon: '⚙', href: '/admin/system' },
        { id: 'admin-ops',      label: 'Operacional IA', icon: '▤', href: '/ops/live' },
        { id: 'admin-backtest', label: 'Backtest',       icon: '⧗', href: '/admin/backtest' },
      ],
    },
    {
      section: 'Diagnóstico',
      items: [
        { id: 'quality',    label: 'Qualidade IA', icon: '◊', href: '/quality.html' },
        { id: 'results',    label: 'Resultados',   icon: '$', href: '/results.html' },
        { id: 'signals',    label: 'Sinais',       icon: '◆', href: '/signals.html' },
      ],
    },
    {
      section: 'Visão cliente',
      items: [
        { id: 'as-client',  label: 'Ver como cliente', icon: '↺', href: '/index.html?asClient=1' },
      ],
    },
  ];

  /* ============================================================
     UTILS
     ============================================================ */
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function getUser() {
    try {
      const us = window.RobotrendUser?.get?.();
      if (us) {
        return {
          ...us.user,
          plan: us.plan, role: us.role,
          isAdmin: us.isAdmin, isPremium: us.isPremium,
        };
      }
      return window.RobotrendAuth?.getUser?.() || null;
    } catch { return null; }
  }

  function isMasterRole(u) {
    if (!u) return false;
    if (u.isAdmin === true) return true;
    const r = String(u.role || '').toLowerCase();
    return MASTER_ROLES.has(r);
  }

  function planLabel(u) {
    if (!u) return 'Visitante';
    const r = String(u.role || '').toLowerCase();
    if (r === 'master' || r === 'super_admin' || r === 'owner') return 'Master';
    if (r === 'admin') return 'Admin';
    if (r === 'premium') return 'Premium';
    const p = String(u.plan || '').toUpperCase();
    if (p === 'PRO' || p === 'PREMIUM') return 'Premium';
    if (p === 'VIP') return 'VIP';
    if (p === 'TRIAL') return 'Trial';
    return 'Free';
  }

  function isFreeUser(u) {
    if (!u) return false;
    const r = String(u.role || '').toLowerCase();
    if (MASTER_ROLES.has(r) || r === 'premium') return false;
    const p = String(u.plan || '').toUpperCase();
    return !(p === 'PREMIUM' || p === 'VIP' || p === 'PRO' || p === 'TRIAL');
  }

  /**
   * Decide qual menu mostrar e qual "kind" identificar — PATH-BASED.
   * A intenção é evitar mistura entre UI cliente e sidebar master numa
   * mesma página. O atalho "Painel Master" aparece dentro do clientNav
   * via injectMasterShortcut() quando o user logado é master, então o
   * admin nunca perde acesso ao painel administrativo.
   * Retorna { nav, kind: 'client' | 'master' }.
   */
  function pickNav(user) {
    const isMasterPath = /^\/(admin|ops)(\/|$|\.html?$)/i.test(location.pathname);
    if (isMasterPath && !location.search.includes('asClient=1')) {
      return { nav: masterNav, kind: 'master' };
    }
    // Default: clientNav em qualquer outra rota (inclusive ?asClient=1
    // dentro de /admin, para preview).
    if (isMasterRole(user)) {
      // Master logado vendo a perspectiva cliente: injeta um atalho ao
      // painel master no topo do clientNav (sem reescrever clientNav).
      return { nav: injectMasterShortcut(clientNav), kind: 'client' };
    }
    return { nav: clientNav, kind: 'client' };
  }

  /**
   * Injeta uma seção "Painel administrativo" no topo do clientNav,
   * permitindo que o master volte rapidamente ao /admin a partir
   * de qualquer página cliente. Não muta o array original.
   */
  function injectMasterShortcut(nav) {
    const shortcut = {
      section: 'Painel administrativo',
      items: [
        { id: 'go-master', label: 'Painel Master',    icon: '◉', href: '/admin' },
        { id: 'go-ops',    label: 'Operacional IA',   icon: '▤', href: '/ops/live' },
      ],
    };
    return [shortcut, ...nav];
  }

  /* ============================================================
     RENDER
     ============================================================ */
  function renderSection(section, active) {
    const items = section.items.map((it) => `
      <a class="saas-nav-item ${active === it.id ? 'active' : ''}"
         href="${it.href}"
         title="${escapeHtml(it.label)}"
         data-nav-id="${escapeHtml(it.id)}">
        <span class="saas-nav-icon" aria-hidden="true">${it.icon}</span>
        <span class="saas-nav-label">${escapeHtml(it.label)}</span>
        ${it.badge ? `<span class="saas-nav-badge">${escapeHtml(it.badge)}</span>` : ''}
      </a>
    `).join('');
    return `
      <div class="saas-nav-group">
        <div class="saas-nav-title">${escapeHtml(section.section)}</div>
        ${items}
      </div>
    `;
  }

  function upgradeCard() {
    return `
      <div class="saas-upgrade-card">
        <div class="promo-pill" style="margin-bottom:8px;">
          <span class="promo-pill-badge">OFERTA</span>
          <span class="promo-pill-text">De <s>R$ 499,99</s> por <b>R$ 199,99</b></span>
        </div>
        <div class="saas-upgrade-title">💎 Desbloqueie o Premium</div>
        <div class="saas-upgrade-desc">Sinais sem delay, Melhor Aposta do Momento e análise IA completa.</div>
        <button type="button" class="saas-upgrade-btn" id="saas-upgrade-btn">Virar Premium — R$ 199,99 →</button>
      </div>
    `;
  }

  function masterBadge() {
    return `
      <div class="saas-master-pill" role="status" aria-label="Modo master admin ativo">
        <span class="saas-master-pill-dot" aria-hidden="true"></span>
        <span class="saas-master-pill-text">MASTER ADMIN</span>
      </div>
    `;
  }

  function renderInto(host) {
    if (!host) return;
    const active = host.dataset.active || '';
    const user = getUser();
    const { nav, kind } = pickNav(user);
    const isMaster = kind === 'master';

    const sectionsHtml = nav.map((s) => renderSection(s, active)).join('');
    const initial = (user?.name?.[0] || user?.email?.[0] || '?').toUpperCase();

    host.innerHTML = `
      <aside class="saas-sidebar saas-sidebar-${kind}">
        <div class="saas-brand">
          <div class="saas-brand-mark">R</div>
          <div class="saas-brand-text">
            <div class="saas-brand-name">Robotrend <span>IA</span></div>
            <div class="saas-brand-tag">${escapeHtml(planLabel(user))}</div>
          </div>
        </div>

        ${isMaster ? masterBadge() : ''}

        <nav class="saas-nav" aria-label="${isMaster ? 'Navegação master' : 'Navegação cliente'}">
          ${sectionsHtml}
        </nav>

        ${(!isMaster && isFreeUser(user)) ? upgradeCard() : ''}

        <div class="saas-user">
          <div class="saas-user-avatar">${escapeHtml(initial)}</div>
          <div class="saas-user-meta">
            <div class="saas-user-name">${escapeHtml(user?.name || user?.email || 'Visitante')}</div>
            <div class="saas-user-sub">${escapeHtml(user?.email || '')}</div>
          </div>
          <button class="saas-user-btn" id="saas-btn-logout" title="Sair" aria-label="Sair">↩</button>
        </div>
      </aside>

      <button class="saas-burger" id="saas-burger" aria-label="Menu" aria-controls="saas-sidebar">≡</button>
      <div class="saas-scrim" id="saas-scrim"></div>
    `;

    // Marca o <body> com o "kind" para estilos contextuais (ex.: index.html
    // esconde o card "Melhor Aposta" quando .saas-mode-master estiver ativo).
    document.body.classList.remove('saas-mode-master', 'saas-mode-client');
    document.body.classList.add(`saas-mode-${kind}`);

    const sidebar = host.querySelector('.saas-sidebar');
    const burger  = host.querySelector('#saas-burger');
    const scrim   = host.querySelector('#saas-scrim');
    const logout  = host.querySelector('#saas-btn-logout');

    function close() { sidebar.classList.remove('open'); scrim.classList.remove('open'); }
    function open()  { sidebar.classList.add('open');    scrim.classList.add('open'); }

    burger?.addEventListener('click', () => sidebar.classList.contains('open') ? close() : open());
    scrim?.addEventListener('click', close);
    logout?.addEventListener('click', () => {
      try { window.RobotrendAuth?.logout?.(); } catch { location.href = '/login.html'; }
    });

    const upgrade = host.querySelector('#saas-upgrade-btn');
    upgrade?.addEventListener('click', () => {
      if (typeof window.virarPremium === 'function') {
        window.virarPremium({ button: upgrade });
      } else {
        location.href = '/account.html';
      }
    });
  }

  /* ============================================================
     BOOTSTRAP & RE-RENDER REACTIONS
     ============================================================ */
  function bootstrap() {
    document.querySelectorAll('[data-saas-nav]').forEach(renderInto);
    const byId = document.getElementById('saas-nav');
    if (byId && !byId.hasAttribute('data-saas-nav')) renderInto(byId);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }

  // Re-render quando o auth-guard confirmar o user via server-side
  window.addEventListener('robotrend:user-ready', () => {
    try { bootstrap(); } catch (_) {}
  });

  // Re-render quando o user vira premium (webhook MP)
  window.addEventListener('robotrend:upgrade-detected', () => {
    try { bootstrap(); } catch (_) {}
  });

  if (window.RobotrendUser?.onChange) {
    window.RobotrendUser.onChange((u, prev) => {
      const tierChanged  = !!u?.isPremium !== !!prev?.isPremium;
      const adminChanged = !!u?.isAdmin   !== !!prev?.isAdmin;
      if (tierChanged || adminChanged) {
        try { bootstrap(); } catch (_) {}
      }
    });
  }

  window.RobotrendNav = {
    renderInto, bootstrap, clientNav, masterNav,
    pickNav, isMasterRole,
  };
})();
