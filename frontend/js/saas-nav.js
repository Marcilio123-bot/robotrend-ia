/* ============================================================
   ROBOTREND IA — SaaS Navigation (sidebar compartilhada)
   Renderiza a navegação coerente em todas as páginas:
     CLIENTE      (Dashboard premium, Sinais, Jogos, Analytics, Minha Assinatura)
     PERFORMANCE  (Resultados, Qualidade IA)        ← visível p/ todos
     MASTER       (Painel SaaS, Usuários, Financeiro, Sistema, Operacional IA, Backtest)
                  ← só aparece se role ∈ {master, admin, owner, super_admin}
   Uso: <div id="saas-nav" data-active="dashboard"></div> + <script src="/js/saas-nav.js"></script>
   ============================================================ */
(function () {
  'use strict';

  const SECTIONS = [
    {
      label: 'Cliente',
      items: [
        { id: 'dashboard',  label: 'Dashboard',        icon: '◧', href: '/index.html' },
        { id: 'signals',    label: 'Sinais',           icon: '◆', href: '/signals.html', badge: 'live' },
        { id: 'football',   label: 'Jogos',            icon: '⚽', href: '/football.html' },
        { id: 'analytics',  label: 'Analytics',        icon: '▲', href: '/analytics.html' },
        { id: 'account',    label: 'Minha Assinatura', icon: '◆', href: '/account.html' },
      ],
    },
    {
      label: 'Performance',
      items: [
        { id: 'results',    label: 'Resultados',   icon: '$', href: '/results.html' },
        { id: 'quality',    label: 'Qualidade IA', icon: '◊', href: '/quality.html' },
      ],
    },
    {
      label: 'Master',
      adminOnly: true,
      items: [
        { id: 'admin',          label: 'Painel',          icon: '◉', href: '/admin.html' },
        { id: 'admin-users',    label: 'Usuários',        icon: '◇', href: '/admin.html#users' },
        { id: 'admin-billing',  label: 'Financeiro',      icon: '◈', href: '/admin.html#billing' },
        { id: 'admin-football', label: 'Sistema',         icon: '⚙', href: '/admin-football.html' },
        { id: 'ops-live',       label: 'Operacional IA',  icon: '▤', href: '/ops/live' },
        { id: 'backtest',       label: 'Backtest',        icon: '⧗', href: '/backtest.html' },
      ],
    },
  ];

  /** Roles consideradas master-level (alinhado com backend/auth.js). */
  const MASTER_ROLES = new Set(['master', 'admin', 'owner', 'super_admin']);

  function getUser() {
    try {
      // Prefere RobotrendUser (server-side truth), fallback auth cache.
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
  function isAdmin(u) {
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

  function renderInto(host) {
    if (!host) return;
    const active = host.dataset.active || '';
    const user = getUser();
    const admin = isAdmin(user);

    const sectionsHtml = SECTIONS
      .filter((s) => !s.adminOnly || admin)
      .map((s) => `
        <div class="saas-nav-group">
          <div class="saas-nav-title">${s.label}</div>
          ${s.items.map((it) => `
            <a class="saas-nav-item ${active === it.id ? 'active' : ''}" href="${it.href}">
              <span class="saas-nav-icon">${it.icon}</span>
              <span class="saas-nav-label">${it.label}</span>
              ${it.badge ? `<span class="saas-nav-badge">${it.badge}</span>` : ''}
            </a>
          `).join('')}
        </div>
      `).join('');

    host.innerHTML = `
      <aside class="saas-sidebar">
        <div class="saas-brand">
          <div class="saas-brand-mark">R</div>
          <div class="saas-brand-text">
            <div class="saas-brand-name">Robotrend <span>IA</span></div>
            <div class="saas-brand-tag">${planLabel(user)}</div>
          </div>
        </div>

        <nav class="saas-nav">
          ${sectionsHtml}
        </nav>

        ${isFreeUser(user) ? `
          <div class="saas-upgrade-card">
            <div class="promo-pill" style="margin-bottom:8px;">
              <span class="promo-pill-badge">OFERTA</span>
              <span class="promo-pill-text">De <s>R$ 499,99</s> por <b>R$ 199,99</b></span>
            </div>
            <div class="saas-upgrade-title">💎 Desbloqueie o Premium</div>
            <div class="saas-upgrade-desc">Sinais sem delay, Melhor Aposta do Momento e análise IA completa.</div>
            <button type="button" class="saas-upgrade-btn" id="saas-upgrade-btn">Virar Premium — R$ 199,99 →</button>
          </div>
        ` : ''}

        <div class="saas-user">
          <div class="saas-user-avatar">${(user?.name?.[0] || user?.email?.[0] || '?').toUpperCase()}</div>
          <div class="saas-user-meta">
            <div class="saas-user-name">${user?.name || user?.email || 'Visitante'}</div>
            <div class="saas-user-sub">${user?.email || ''}</div>
          </div>
          <button class="saas-user-btn" id="saas-btn-logout" title="Sair" aria-label="Sair">↩</button>
        </div>
      </aside>

      <button class="saas-burger" id="saas-burger" aria-label="Menu" aria-controls="saas-sidebar">≡</button>
      <div class="saas-scrim" id="saas-scrim"></div>
    `;

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

  function bootstrap() {
    document.querySelectorAll('[data-saas-nav]').forEach(renderInto);
    // Compat: também aceita id #saas-nav
    const byId = document.getElementById('saas-nav');
    if (byId && !byId.hasAttribute('data-saas-nav')) renderInto(byId);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }

  // Re-render quando o auth-guard confirmar o user via server-side
  // (garante que o item "Admin" aparece/desaparece quando a role realmente muda).
  window.addEventListener('robotrend:user-ready', () => {
    try { bootstrap(); } catch (_) {}
  });

  // Também re-render quando RobotrendUser detectar mudança de plano
  // (ex: webhook MP aprovou pagamento → user vira premium em tempo real).
  // O upgrade some o CTA "Virar Premium" do sidebar automaticamente.
  window.addEventListener('robotrend:upgrade-detected', () => {
    try { bootstrap(); } catch (_) {}
  });
  if (window.RobotrendUser?.onChange) {
    window.RobotrendUser.onChange((u, prev) => {
      const tierChanged = !!u?.isPremium !== !!prev?.isPremium;
      const adminChanged = !!u?.isAdmin !== !!prev?.isAdmin;
      if (tierChanged || adminChanged) {
        try { bootstrap(); } catch (_) {}
      }
    });
  }

  window.RobotrendNav = { renderInto, bootstrap };
})();
