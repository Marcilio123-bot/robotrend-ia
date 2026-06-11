/* Robotrend IA — Painel de Analytics de Usuários (admin)
   O auth-guard.js (meta robotrend-guard="admin") já bloqueia não-admins.
*/
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);

  let currentFilter = '';
  let searchTerm = '';
  let searchTimer = null;

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  /** "Último acesso" relativo: Hoje HH:MM, Ontem HH:MM, Há N dias, ou data. */
  function fmtLastSeen(iso) {
    if (!iso) return 'Nunca';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'Nunca';
    const now = new Date();
    const startToday = new Date(now); startToday.setHours(0, 0, 0, 0);
    const hhmm = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const dayMs = 24 * 3600 * 1000;
    const diffDays = Math.floor((startToday.getTime() - new Date(d).setHours(0, 0, 0, 0)) / dayMs);
    if (diffDays <= 0) return `Hoje ${hhmm}`;
    if (diffDays === 1) return `Ontem ${hhmm}`;
    if (diffDays < 7) return `Há ${diffDays} dias`;
    return fmtDate(iso);
  }

  function planPill(u) {
    if (u.isPremium) {
      const label = String(u.plan || 'PREMIUM').toUpperCase() === 'VIP' ? 'VIP' : 'Premium';
      return `<span class="ua-plan-pill ua-plan-premium">${label}</span>`;
    }
    return `<span class="ua-plan-pill ua-plan-free">Free</span>`;
  }

  function isInactive(u) {
    if (!u.lastSeenAt) return true;
    return (Date.now() - new Date(u.lastSeenAt).getTime()) > 7 * 24 * 3600 * 1000;
  }

  function renderSummary(s) {
    $('#kpi-total').textContent = s.totalUsers ?? 0;
    $('#kpi-today').textContent = s.activeToday ?? 0;
    $('#kpi-7d').textContent = s.active7d ?? 0;
    $('#kpi-premium').textContent = s.premiumUsers ?? 0;
    $('#kpi-free').textContent = s.freeUsers ?? 0;
  }

  function renderRows(users) {
    const body = $('#ua-body');
    if (!users.length) {
      body.innerHTML = `<tr><td colspan="7" class="py-6 text-center" style="color:var(--muted);">Nenhum usuário encontrado.</td></tr>`;
      $('#ua-count').textContent = '';
      return;
    }
    body.innerHTML = users.map((u) => {
      const name = escapeHtml(u.name || (u.email || '').split('@')[0]);
      const email = escapeHtml(u.email || '');
      return `
        <tr class="${isInactive(u) ? 'ua-inactive' : ''}" style="border-top:1px solid var(--line);">
          <td class="py-3 px-4">
            <div style="font-weight:700;">${name}</div>
            <div class="text-[11px]" style="color:var(--muted);">${email}</div>
          </td>
          <td class="py-3 px-4">${fmtDate(u.createdAt)}</td>
          <td class="py-3 px-4">${escapeHtml(fmtLastSeen(u.lastSeenAt))}</td>
          <td class="py-3 px-4 text-right ua-num">${u.loginCount ?? 0}</td>
          <td class="py-3 px-4 text-right ua-num">${u.gamesAnalyzedCount ?? 0}</td>
          <td class="py-3 px-4 text-right ua-num">${u.signalsViewedCount ?? 0}</td>
          <td class="py-3 px-4">${planPill(u)}</td>
        </tr>`;
    }).join('');
    $('#ua-count').textContent = `${users.length} usuário(s) exibido(s)`;
  }

  async function load() {
    const body = $('#ua-body');
    body.innerHTML = `<tr><td colspan="7" class="py-6 text-center" style="color:var(--muted);">Carregando…</td></tr>`;
    try {
      const params = new URLSearchParams();
      if (currentFilter) params.set('filter', currentFilter);
      if (searchTerm) params.set('q', searchTerm);
      const data = await RobotrendAuth.api(`/api/admin/analytics?${params.toString()}`);
      renderSummary(data.summary || {});
      renderRows(data.users || []);
    } catch (e) {
      body.innerHTML = `<tr><td colspan="7" class="py-6 text-center" style="color:var(--danger,#ef4444);">Erro ao carregar: ${escapeHtml(e.message)}</td></tr>`;
    }
  }

  document.querySelectorAll('.ua-filter').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ua-filter').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter || '';
      load();
    });
  });

  $('#ua-search')?.addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTerm = e.target.value.trim();
      load();
    }, 300);
  });

  load();
})();
