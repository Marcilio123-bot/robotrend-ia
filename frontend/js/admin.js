/* Robotrend IA — Admin
   Nota: o auth-guard.js (via <meta name="robotrend-guard" content="admin">)
   já bloqueou acesso aqui se o usuário não for admin. Este script assume
   que estamos autenticados E que role === 'admin'.
*/
(async function () {
  'use strict';

  // Aguarda o guard confirmar o user via server-side
  let me = null;
  try {
    if (window.RobotrendGuard?.ready) {
      me = await window.RobotrendGuard.ready;
    } else {
      me = (await RobotrendAuth.api('/api/auth/me'))?.user;
    }
  } catch (_) { /* guard já redirecionou */ }
  if (!me) {
    console.warn('[ADMIN UI] admin.js abortou: usuário não autenticado (RobotrendGuard.ready vazio)');
    return;
  }

  console.log('[ADMIN UI] admin.js iniciado', { email: me.email, role: me.role, path: location.pathname });

  const meEl = document.getElementById('me');
  if (meEl) meEl.textContent = `${me.email} · ADMIN`;
  document.getElementById('btn-logout')?.addEventListener('click', RobotrendAuth.logout);

  // Preço promo do PREMIUM (usado para estimativa de receita FREE→PREMIUM)
  const PREMIUM_PRICE = 199.99;

  /** Helper defensivo: páginas admin sub-rota nem sempre tem todos os IDs. */
  function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  const USER_TABLE_IDS = [
    'premium-body', 'free-body', 'admin-body', 'form-create-user',
    'users-summary-body', 'users-section', 'users-render-status',
  ];
  const USER_KPI_IDS = ['kpi-free', 'kpi-conversion', 'premium-count', 'free-count'];

  function probeMounts() {
    const mounts = {};
    for (const id of [...USER_TABLE_IDS, ...USER_KPI_IDS, 'admins-section', 'admin-users-error']) {
      mounts[id] = !!document.getElementById(id);
    }
    return mounts;
  }

  /** IDs reais no DOM (não confundir com premium-users-body / free-users-body). */
  const TBODY_PREMIUM = 'premium-body';
  const TBODY_FREE = 'free-body';
  const TBODY_ADMIN = 'admin-body';
  const TBODY_SUMMARY = 'users-summary-body';

  function normRole(u) {
    return String(u?.role || 'user').toLowerCase();
  }
  function normPlan(u) {
    return String(u?.plan || 'FREE').toUpperCase();
  }
  function isAdminUser(u) {
    const r = normRole(u);
    return r === 'admin' || r === 'owner' || r === 'master' || r === 'super_admin';
  }
  function isPremiumClient(u) {
    const p = normPlan(u);
    const r = normRole(u);
    return p === 'PREMIUM' || p === 'VIP' || r === 'premium';
  }

  function logAdminRender(ctx) {
    const premiumBody = document.getElementById(TBODY_PREMIUM);
    const freeBody = document.getElementById(TBODY_FREE);
    const adminBody = document.getElementById(TBODY_ADMIN);
    const summaryBody = document.getElementById(TBODY_SUMMARY);
    console.log('[ADMIN RENDER]', {
      ...ctx,
      premiumBody: !!premiumBody,
      freeBody: !!freeBody,
      adminBody: !!adminBody,
      summaryBody: !!summaryBody,
      premiumHtmlLength: premiumBody?.innerHTML?.length ?? 0,
      freeHtmlLength: freeBody?.innerHTML?.length ?? 0,
      adminHtmlLength: adminBody?.innerHTML?.length ?? 0,
      summaryHtmlLength: summaryBody?.innerHTML?.length ?? 0,
      usersLength: ctx.usersLength ?? 0,
      htmlLength: ctx.htmlLength ?? 0,
    });
  }

  function setUsersRenderStatus(msg, kind = '') {
    const el = document.getElementById('users-render-status');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('ok', 'err');
    if (kind) el.classList.add(kind);
  }

  function ensureUsersSectionVisible() {
    const sec = document.getElementById('users-section');
    if (!sec) return;
    sec.style.display = 'block';
    sec.style.visibility = 'visible';
    sec.style.opacity = '1';
  }

  function setTbodyHtml(tbodyId, html, label) {
    const body = document.getElementById(tbodyId);
    if (!body) {
      console.warn('[ADMIN RENDER] tbody ausente:', tbodyId, label);
      return 0;
    }
    body.innerHTML = html;
    return html.length;
  }

  function whenDomReady() {
    if (document.readyState !== 'loading') return Promise.resolve();
    return new Promise((resolve) => {
      document.addEventListener('DOMContentLoaded', resolve, { once: true });
    });
  }

  /** Log estruturado para diagnosticar CRUD no admin.html */
  function logAdminUi(state) {
    console.log('[ADMIN UI]', state);
  }

  function showUsersError(msg) {
    const el = document.getElementById('admin-users-error');
    if (!el) return;
    if (!msg) {
      el.style.display = 'none';
      el.textContent = '';
      return;
    }
    el.textContent = msg;
    el.style.display = 'block';
  }

  async function loadOverview() {
    try {
      const o = await RobotrendAuth.api('/api/admin/overview');
      setText('kpi-users',   o.users ?? '—');
      setText('kpi-premium', o.paidUsers ?? '—');
      setText('kpi-revenue', 'R$ ' + (Number(o.revenue) || 0).toFixed(2));
      setText('kpi-signals', o.signals ?? '—');
      setText('kpi-winrate', (o.signalsStats?.winrate ?? 0) + '%');
      // kpi-free, kpi-conversion → refinados por loadUsers()
    } catch (e) {
      console.error('[ADMIN UI] loadOverview failed', e);
    }
  }

  function planBadge(plan, role) {
    if (role === 'admin' || role === 'owner') return '<span class="plan-badge admin">ADMIN</span>';
    if (plan === 'PREMIUM' || role === 'premium') return '<span class="plan-badge premium">💎 PREMIUM</span>';
    if (plan === 'VIP') return '<span class="plan-badge vip">VIP</span>';
    return '<span class="plan-badge free">FREE</span>';
  }
  function statusBadge(active, isBlocked) {
    if (isBlocked) return '<span class="plan-badge inactive" style="background:rgba(255,85,102,.12);color:#ffadb5;border-color:rgba(255,85,102,.4);">⛔ BLOQUEADO</span>';
    return active
      ? '<span class="plan-badge active">● ATIVO</span>'
      : '<span class="plan-badge inactive">○ inativo</span>';
  }
  function fmtDate(d) {
    if (!d) return '—';
    try { return new Date(d).toLocaleDateString('pt-BR'); } catch (_) { return '—'; }
  }
  function fmtDateTime(d) {
    if (!d) return '—';
    try { return new Date(d).toLocaleString('pt-BR'); } catch (_) { return '—'; }
  }
  function relTime(d) {
    if (!d) return '—';
    const ts = new Date(d).getTime();
    if (!Number.isFinite(ts)) return '—';
    const diff = Date.now() - ts;
    if (diff < 60_000)          return 'agora';
    if (diff < 3_600_000)       return Math.floor(diff / 60_000) + ' min atrás';
    if (diff < 86_400_000)      return Math.floor(diff / 3_600_000) + 'h atrás';
    if (diff < 30 * 86_400_000) return Math.floor(diff / 86_400_000) + 'd atrás';
    return fmtDate(d);
  }
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]);
  }

  function flash(el, msg, kind = 'ok') {
    if (!el) return;
    const colors = {
      ok:   'background:rgba(20,184,94,.1);color:#22c55e;border:1px solid rgba(20,184,94,.4)',
      err:  'background:rgba(255,85,102,.1);color:#ffd1d6;border:1px solid rgba(255,85,102,.4)',
      warn: 'background:rgba(255,181,71,.1);color:#ffd599;border:1px solid rgba(255,181,71,.4)',
    };
    el.style.cssText = `padding:8px 12px;border-radius:8px;font-size:13px;${colors[kind] || colors.ok}`;
    el.textContent = msg;
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 4500);
  }

  /* ============================================================
     LOAD USERS — separa em PREMIUM, FREE, ADMIN e renderiza KPIs
     ============================================================ */
  /** Tabela-resumo no topo da seção — lista todos os usuários (sempre visível). */
  function renderUsersSummary(allUsers) {
    const html = !allUsers.length
      ? '<tr><td colspan="4" class="py-6 text-center" style="color:var(--muted);">Nenhum usuário cadastrado.</td></tr>'
      : allUsers.map((u) => {
          const blocked = u.active === false;
          return `<tr${blocked ? ' style="opacity:.55;"' : ''}>
            <td class="py-3 px-4 font-mono text-xs">${escapeHtml(u.email)}</td>
            <td class="py-3 px-4">${planBadge(normPlan(u), normRole(u))}</td>
            <td class="py-3 px-4 text-xs">${escapeHtml(normRole(u))}</td>
            <td class="py-3 px-4">${statusBadge(!blocked, blocked)}</td>
          </tr>`;
        }).join('');
    const len = setTbodyHtml(TBODY_SUMMARY, html, 'summary');
    logAdminRender({ stage: 'renderUsersSummary', usersLength: allUsers.length, htmlLength: len });
    return len;
  }

  function renderUsersTables(premium, free, admins, allUsers) {
    ensureUsersSectionVisible();
    let totalHtml = 0;
    totalHtml += renderPremiumTable(premium) || 0;
    totalHtml += renderFreeTable(free) || 0;
    totalHtml += renderAdminTable(admins) || 0;
    totalHtml += renderUsersSummary(allUsers || [...premium, ...free, ...admins]) || 0;
    const adminsSection = document.getElementById('admins-section');
    if (adminsSection) adminsSection.style.display = admins.length > 1 ? 'block' : 'none';
    logAdminRender({
      stage: 'renderUsersTables:done',
      usersLength: (allUsers || []).length,
      htmlLength: totalHtml,
      premium: premium.length,
      free: free.length,
      admins: admins.length,
    });
  }

  async function loadUsers() {
    const mounts = probeMounts();
    let usersLoaded = false;
    let rowsRendered = 0;

    logAdminUi({
      stage: 'loadUsers:start',
      usersLoaded,
      containersFound: mounts,
      rowsRendered,
      mounts,
      adminJsLoaded: true,
    });

    if (!mounts[TBODY_PREMIUM] && !mounts[TBODY_FREE] && !mounts[TBODY_SUMMARY]) {
      const msg = 'Containers das tabelas não encontrados (premium-body / free-body / users-summary-body). Verifique admin.html.';
      console.warn('[ADMIN UI]', msg);
      showUsersError(msg);
      setUsersRenderStatus(msg, 'err');
      logAdminUi({ stage: 'loadUsers:abort', usersLoaded: false, containersFound: mounts, rowsRendered: 0, mounts });
      logAdminRender({ stage: 'loadUsers:abort', usersLength: 0, htmlLength: 0 });
      return { ok: false, reason: 'no-containers' };
    }

    try {
      const data = await RobotrendAuth.api('/api/admin/users');
      const users = Array.isArray(data?.users) ? data.users
        : Array.isArray(data) ? data : [];
      usersLoaded = true;
      showUsersError(null);

      const admins = users.filter(isAdminUser);
      const nonAdmin = users.filter((u) => !isAdminUser(u));
      const premium = nonAdmin.filter(isPremiumClient);
      const free = nonAdmin.filter((u) => !isPremiumClient(u));

      const totalClients = nonAdmin.length;
      const conversionPct = totalClients > 0 ? (premium.length / totalClients) * 100 : 0;
      const revenueEstimate = premium.length * PREMIUM_PRICE;

      setText('kpi-free', String(free.length));
      setText('kpi-premium', String(premium.length));
      setText('kpi-conversion', conversionPct.toFixed(1) + '%');
      setText('premium-count', String(premium.length));
      setText('premium-revenue', 'R$ ' + revenueEstimate.toFixed(2).replace('.', ','));
      setText('free-count', String(free.length));
      setText('free-conversion', conversionPct.toFixed(1) + '%');
      setText('admin-count', String(admins.length));

      renderUsersTables(premium, free, admins, users);
      rowsRendered = users.length;
      setUsersRenderStatus(
        `✓ ${users.length} usuário(s) renderizado(s) · ${premium.length} premium · ${free.length} free · ${admins.length} admin`,
        'ok',
      );

      logAdminUi({
        stage: 'loadUsers:ok',
        usersLoaded,
        containersFound: probeMounts(),
        rowsRendered,
        mounts: probeMounts(),
        counts: { total: users.length, premium: premium.length, free: free.length, admins: admins.length },
      });

      return { ok: true, users, premium, free, admins };
    } catch (e) {
      console.error('[ADMIN UI] loadUsers failed', e);
      showUsersError(`Falha ao carregar usuários: ${e.message || 'erro desconhecido'}. Confira /api/admin/users no Network.`);

      setUsersRenderStatus(`Erro: ${e.message || 'falha ao carregar'}`, 'err');

      // Sai do estado "Carregando…" mesmo em erro
      if (mounts[TBODY_PREMIUM]) {
        setTbodyHtml(TBODY_PREMIUM,
          '<tr><td colspan="7" class="py-6 text-center" style="color:var(--danger);">Erro ao carregar usuários</td></tr>',
          'premium-error');
      }
      if (mounts[TBODY_FREE]) {
        setTbodyHtml(TBODY_FREE,
          '<tr><td colspan="6" class="py-6 text-center" style="color:var(--danger);">Erro ao carregar usuários</td></tr>',
          'free-error');
      }
      if (mounts[TBODY_SUMMARY]) {
        setTbodyHtml(TBODY_SUMMARY,
          '<tr><td colspan="4" class="py-6 text-center" style="color:var(--danger);">Erro ao carregar usuários</td></tr>',
          'summary-error');
      }

      logAdminUi({
        stage: 'loadUsers:error',
        usersLoaded: false,
        containersFound: probeMounts(),
        rowsRendered: 0,
        mounts: probeMounts(),
        error: e.message,
      });

      return { ok: false, reason: e.message };
    }
  }

  /* ---------- PREMIUM TABLE ---------- */
  function renderPremiumTable(users) {
    const body = document.getElementById(TBODY_PREMIUM);
    if (!body) {
      logAdminRender({ stage: 'renderPremiumTable:missing-body', usersLength: users.length, htmlLength: 0 });
      return 0;
    }
    if (!users.length) {
      const html = `<tr><td colspan="7" class="py-6 text-center" style="color:var(--muted);">Nenhum cliente PREMIUM ainda. 💎</td></tr>`;
      const len = setTbodyHtml(TBODY_PREMIUM, html, 'premium-empty');
      logAdminRender({ stage: 'renderPremiumTable:empty', usersLength: 0, htmlLength: len });
      return len;
    }
    const html = users.map(u => {
      const isMe = u.id === me.id;
      const isBlocked = u.active === false;
      const active = !isBlocked;
      return `
        <tr data-user-id="${u.id}" ${isBlocked ? 'style="opacity:.55;"' : ''}>
          <td class="py-3 px-4 font-mono text-xs">${escapeHtml(u.email)}${isMe ? ' <span style="color:var(--brand);">(você)</span>' : ''}</td>
          <td class="py-3 px-4">${escapeHtml(u.name || '—')}</td>
          <td class="py-3 px-4">
            <select data-id="${u.id}" class="user-plan rounded px-2 py-1 text-xs" style="background: var(--surface-2); border: 1px solid var(--line); color: var(--text);">
              ${['FREE','VIP','PREMIUM'].map(p => `<option value="${p}" ${p === u.plan ? 'selected' : ''}>${p}</option>`).join('')}
            </select>
          </td>
          <td class="py-3 px-4">
            <select data-id="${u.id}" class="user-role rounded px-2 py-1 text-xs" style="background: var(--surface-2); border: 1px solid var(--line); color: var(--text);" ${isMe ? 'disabled' : ''}>
              <option value="user"    ${u.role === 'user' ? 'selected' : ''}>user</option>
              <option value="premium" ${u.role === 'premium' ? 'selected' : ''}>premium</option>
              <option value="admin"   ${u.role === 'admin' ? 'selected' : ''}>admin</option>
            </select>
          </td>
          <td class="py-3 px-4 text-xs" style="color: var(--muted);">${fmtDate(u.createdAt)}</td>
          <td class="py-3 px-4">${statusBadge(active, isBlocked)}</td>
          <td class="py-3 px-4">
            <div class="flex gap-1 flex-wrap">
              <button class="btn-ghost btn-save text-xs" data-id="${u.id}">Salvar</button>
              <button class="btn-ghost btn-reset-pw text-xs" data-id="${u.id}" data-email="${escapeHtml(u.email)}">Senha</button>
              ${isMe ? '' : `<button class="btn-ghost btn-toggle-active text-xs" data-id="${u.id}" data-email="${escapeHtml(u.email)}" data-active="${isBlocked ? 'false' : 'true'}">${isBlocked ? 'Desbloquear' : 'Bloquear'}</button>`}
              ${isMe ? '' : `<button class="btn-ghost btn-del text-xs" data-id="${u.id}" data-email="${escapeHtml(u.email)}" style="color:#ff6677;">Remover</button>`}
            </div>
          </td>
        </tr>`;
    }).join('');
    const len = setTbodyHtml(TBODY_PREMIUM, html, 'premium');
    wireRowActions(body);
    logAdminRender({ stage: 'renderPremiumTable', usersLength: users.length, htmlLength: len });
    return len;
  }

  /* ---------- FREE TABLE ---------- */
  function renderFreeTable(users) {
    const body = document.getElementById(TBODY_FREE);
    if (!body) {
      logAdminRender({ stage: 'renderFreeTable:missing-body', usersLength: users.length, htmlLength: 0 });
      return 0;
    }
    if (!users.length) {
      const html = `<tr><td colspan="6" class="py-6 text-center" style="color:var(--muted);">Sem clientes FREE no momento.</td></tr>`;
      const len = setTbodyHtml(TBODY_FREE, html, 'free-empty');
      logAdminRender({ stage: 'renderFreeTable:empty', usersLength: 0, htmlLength: len });
      return len;
    }
    const html = users.map(u => {
      const lastSeen = u.updatedAt || u.lastSeenAt || u.createdAt;
      const isBlocked = u.active === false;
      return `
        <tr data-user-id="${u.id}" ${isBlocked ? 'style="opacity:.55;"' : ''}>
          <td class="py-3 px-4 font-mono text-xs">${escapeHtml(u.email)} ${isBlocked ? statusBadge(false, true) : ''}</td>
          <td class="py-3 px-4">${escapeHtml(u.name || '—')}</td>
          <td class="py-3 px-4 text-xs" style="color: var(--muted);">${fmtDate(u.createdAt)}</td>
          <td class="py-3 px-4 text-xs" style="color: var(--muted);">${relTime(lastSeen)}</td>
          <td class="py-3 px-4">
            <button class="btn-promote text-xs" data-id="${u.id}" data-email="${escapeHtml(u.email)}"
              style="background: linear-gradient(135deg,#fbbf24,#f59e0b); color:#3b2406; padding: 6px 12px; border-radius: 6px; font-weight: 800; border: 0; cursor: pointer;">
              💎 Converter Premium
            </button>
          </td>
          <td class="py-3 px-4">
            <div class="flex gap-1 flex-wrap">
              <button class="btn-ghost btn-reset-pw text-xs" data-id="${u.id}" data-email="${escapeHtml(u.email)}">Senha</button>
              <button class="btn-ghost btn-toggle-active text-xs" data-id="${u.id}" data-email="${escapeHtml(u.email)}" data-active="${isBlocked ? 'false' : 'true'}">${isBlocked ? 'Desbloquear' : 'Bloquear'}</button>
              <button class="btn-ghost btn-del text-xs" data-id="${u.id}" data-email="${escapeHtml(u.email)}" style="color:#ff6677;">Remover</button>
            </div>
          </td>
        </tr>`;
    }).join('');
    const len = setTbodyHtml(TBODY_FREE, html, 'free');
    wireRowActions(body);
    logAdminRender({ stage: 'renderFreeTable', usersLength: users.length, htmlLength: len });

    // botão "Converter Premium" (exclusivo da tabela FREE)
    body.querySelectorAll('.btn-promote').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const email = btn.dataset.email;
        if (!confirm(`Converter ${email} para PREMIUM agora?\n\nEste é um upgrade manual — normalmente isso é feito automaticamente pelo webhook de pagamento.`)) return;
        try {
          btn.disabled = true;
          btn.textContent = '⏳';
          await RobotrendAuth.api(`/api/admin/users/${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ plan: 'PREMIUM', role: 'premium' }),
          });
          await loadUsers();
          await loadOverview();
        } catch (e) {
          alert('Falha ao converter: ' + e.message);
          btn.disabled = false;
          btn.textContent = '💎 Converter Premium';
        }
      });
    });
    return len;
  }

  /* ---------- ADMIN TABLE ---------- */
  function renderAdminTable(users) {
    const body = document.getElementById(TBODY_ADMIN);
    if (!body) {
      logAdminRender({ stage: 'renderAdminTable:missing-body', usersLength: users.length, htmlLength: 0 });
      return 0;
    }
    if (!users.length) {
      const html = `<tr><td colspan="5" class="py-6 text-center" style="color:var(--muted);">—</td></tr>`;
      const len = setTbodyHtml(TBODY_ADMIN, html, 'admin-empty');
      logAdminRender({ stage: 'renderAdminTable:empty', usersLength: 0, htmlLength: len });
      return len;
    }
    const html = users.map(u => {
      const isMe = u.id === me.id;
      const isBlocked = u.active === false;
      return `
        <tr data-user-id="${u.id}" ${isBlocked ? 'style="opacity:.55;"' : ''}>
          <td class="py-3 px-4 font-mono text-xs">${escapeHtml(u.email)}${isMe ? ' <span style="color:var(--brand);">(você)</span>' : ''} ${isBlocked ? statusBadge(false, true) : ''}</td>
          <td class="py-3 px-4">${escapeHtml(u.name || '—')}</td>
          <td class="py-3 px-4">${planBadge(u.plan, u.role)}</td>
          <td class="py-3 px-4 text-xs" style="color: var(--muted);">${fmtDate(u.createdAt)}</td>
          <td class="py-3 px-4">
            <div class="flex gap-1 flex-wrap">
              <button class="btn-ghost btn-reset-pw text-xs" data-id="${u.id}" data-email="${escapeHtml(u.email)}">Senha</button>
              ${isMe ? '' : `<button class="btn-ghost btn-toggle-active text-xs" data-id="${u.id}" data-email="${escapeHtml(u.email)}" data-active="${isBlocked ? 'false' : 'true'}">${isBlocked ? 'Desbloquear' : 'Bloquear'}</button>`}
              ${isMe ? '' : `<button class="btn-ghost btn-del text-xs" data-id="${u.id}" data-email="${escapeHtml(u.email)}" style="color:#ff6677;">Remover</button>`}
            </div>
          </td>
        </tr>`;
    }).join('');
    const len = setTbodyHtml(TBODY_ADMIN, html, 'admin');
    wireRowActions(body);
    logAdminRender({ stage: 'renderAdminTable', usersLength: users.length, htmlLength: len });
    return len;
  }

  /* ---------- ACTIONS (compartilhado) ---------- */
  function wireRowActions(body) {
    body.querySelectorAll('.btn-save').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const plan = (body.querySelector(`.user-plan[data-id="${id}"]`)?.value || '').trim();
        const role = (body.querySelector(`.user-role[data-id="${id}"]`)?.value || '').trim();
        try {
          await RobotrendAuth.api(`/api/admin/users/${id}`, {
            method: 'PATCH', body: JSON.stringify({ plan, role }),
          });
          btn.textContent = '✅ Salvo';
          setTimeout(() => { btn.textContent = 'Salvar'; loadUsers(); }, 1200);
        } catch (e) { alert(e.message); }
      });
    });

    body.querySelectorAll('.btn-reset-pw').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const email = btn.dataset.email;
        const pw = (prompt(`Nova senha para ${email} (mínimo 6 chars):`) || '').trim();
        if (!pw) return;
        if (pw.length < 6) { alert('Senha mínima 6 chars'); return; }
        try {
          await RobotrendAuth.api(`/api/admin/users/${id}/password`, {
            method: 'POST', body: JSON.stringify({ password: pw }),
          });
          btn.textContent = '✅';
          setTimeout(() => btn.textContent = 'Senha', 1800);
        } catch (e) { alert(e.message); }
      });
    });

    body.querySelectorAll('.btn-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const email = btn.dataset.email;
        if (!confirm(`Remover o cliente ${email}? Esta ação não pode ser desfeita.`)) return;
        try {
          await RobotrendAuth.api(`/api/admin/users/${id}`, { method: 'DELETE' });
          await loadUsers();
          loadOverview();
        } catch (e) { alert(e.message); }
      });
    });

    // Bloquear / Desbloquear (toggle active). O backend rejeita login com
    // active=false (USER_BLOCKED). updateUser aceita patch.active boolean.
    body.querySelectorAll('.btn-toggle-active').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const email = btn.dataset.email;
        const wasActive = btn.dataset.active === 'true';
        const willBlock = wasActive; // se estava ativo, vamos bloquear
        const verb = willBlock ? 'bloquear' : 'desbloquear';
        if (!confirm(`Tem certeza que deseja ${verb} ${email}?`)) return;
        try {
          btn.disabled = true;
          const original = btn.textContent;
          btn.textContent = '⏳';
          await RobotrendAuth.api(`/api/admin/users/${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ active: !willBlock }),
          });
          await loadUsers();
          window.RobotrendToast?.success?.(`Usuário ${email} ${willBlock ? 'bloqueado' : 'desbloqueado'}.`);
        } catch (e) {
          alert(e.message);
          btn.disabled = false;
        }
      });
    });
  }

  /* ============================================================
     CREATE USER (form principal SaaS)
     ============================================================ */
  document.getElementById('form-create-user')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fb = document.getElementById('cu-feedback');
    // Trim defensivo — optional chaining + fallback string vazia
    const payload = {
      email:    (document.getElementById('cu-email')?.value    || '').trim().toLowerCase(),
      password: (document.getElementById('cu-password')?.value || '').trim(),
      name:     (document.getElementById('cu-name')?.value     || '').trim() || undefined,
      plan:     (document.getElementById('cu-plan')?.value     || 'FREE'),
      role:     (document.getElementById('cu-role')?.value     || 'user'),
    };
    if (!payload.email || !payload.password) {
      flash(fb, 'Preencha e-mail e senha.', 'err');
      return;
    }
    try {
      const r = await RobotrendAuth.api('/api/admin/users', {
        method: 'POST', body: JSON.stringify(payload),
      });
      flash(fb, `Cliente ${r.user.email} criado como ${r.user.role}/${r.user.plan}.`, 'ok');
      ev.target.reset();
      const planSel = document.getElementById('cu-plan');
      const roleSel = document.getElementById('cu-role');
      if (planSel) planSel.value = 'PREMIUM';
      if (roleSel) roleSel.value = 'premium';
      loadUsers();
      loadOverview();
    } catch (e) {
      flash(fb, e.message || 'Falha ao criar usuário.', 'err');
    }
  });

  async function loadPayments() {
    const body = document.getElementById('payments-body');
    if (!body) return;
    try {
      const { payments } = await RobotrendAuth.api('/api/admin/payments');
      const list = Array.isArray(payments) ? payments : [];
      if (!list.length) {
        body.innerHTML = '<tr><td colspan="5" class="py-6 text-center" style="color:var(--muted);">Sem pagamentos</td></tr>';
        return;
      }
      body.innerHTML = list.map((p) => `
        <tr>
          <td class="py-3 px-4 font-mono text-xs">${new Date(p.created_at).toLocaleString('pt-BR')}</td>
          <td class="py-3 px-4">${escapeHtml(p.provider)}</td>
          <td class="py-3 px-4">${escapeHtml(p.plan)}</td>
          <td class="py-3 px-4 font-mono">R$ ${Number(p.amount_brl || p.amount || 0).toFixed(2)}</td>
          <td class="py-3 px-4"><span class="badge ${p.status === 'paid' ? 'win' : ''}">${escapeHtml(p.status)}</span></td>
        </tr>
      `).join('');
    } catch (e) { console.error('[ADMIN UI] loadPayments', e); }
  }

  async function loadSignals() {
    const body = document.getElementById('signals-body');
    if (!body) return;
    try {
      const { signals } = await RobotrendAuth.api('/api/admin/signals');
      const list = Array.isArray(signals) ? signals : [];
      if (!list.length) {
        body.innerHTML = '<tr><td colspan="6" class="py-6 text-center" style="color:var(--muted);">Sem sinais</td></tr>';
        return;
      }
      body.innerHTML = list.slice(0, 50).map((s) => {
        const t = s.created_at || s.createdAt;
        const result = s.result || 'pending';
        const badge = result === 'win' ? '<span class="badge win">WIN</span>'
          : result === 'loss' ? '<span class="badge loss">LOSS</span>'
          : '<span class="badge">aguard.</span>';
        return `
          <tr>
            <td class="py-3 px-4 font-mono text-xs">${t ? new Date(t).toLocaleTimeString('pt-BR') : ''}</td>
            <td class="py-3 px-4">${s.home} × ${s.away}</td>
            <td class="py-3 px-4"><span class="badge live">${s.market}</span></td>
            <td class="py-3 px-4">${s.suggestion}</td>
            <td class="py-3 px-4 font-mono">${s.confidence}%</td>
            <td class="py-3 px-4">${badge}</td>
          </tr>`;
      }).join('');
    } catch (e) { console.error('[ADMIN UI] loadSignals', e); }
  }

  async function loadCoupons() {
    const el = document.getElementById('coupons-list');
    if (!el) return;
    try {
      const { coupons } = await RobotrendAuth.api('/api/beta/coupons');
      const list = Array.isArray(coupons) ? coupons : [];
      if (!list.length) {
        el.innerHTML = '<span style="color:var(--muted);">Nenhum cupom criado.</span>';
        return;
      }
      el.innerHTML = list.map((c) => `
        <div class="flex justify-between py-1" style="border-bottom: 1px solid var(--card-border);">
          <code style="background: var(--bg-2); padding: 2px 6px; border-radius: 3px;">${escapeHtml(c.code)}</code>
          <span>-${c.value}% · ${c.used}/${c.maxUses} usos</span>
        </div>`).join('');
    } catch (e) { console.error('[ADMIN UI] loadCoupons', e); }
  }

  async function loadFeedback() {
    const statsEl = document.getElementById('feedback-stats');
    const listEl = document.getElementById('feedback-list');
    if (!statsEl && !listEl) return;
    try {
      const r = await RobotrendAuth.api('/api/beta/feedback');
      const stats = r.stats || {};
      if (statsEl) {
        statsEl.textContent = `${stats.count ?? 0} mensagens · Nota média: ${stats.avgRating ?? '—'}/5`;
      }
      if (!listEl) return;
      const feedback = Array.isArray(r.feedback) ? r.feedback : [];
      if (!feedback.length) {
        listEl.innerHTML = '<span style="color:var(--muted);">Nenhum feedback ainda.</span>';
        return;
      }
      listEl.innerHTML = feedback.slice(0, 100).map((f) => `
        <div class="card" style="padding: 10px;">
          <div class="flex justify-between text-xs" style="color: var(--muted);">
            <span>${escapeHtml(f.email || 'anônimo')}</span>
            <span>${'★'.repeat(f.rating)}${'☆'.repeat(5 - f.rating)} · ${new Date(f.createdAt).toLocaleString('pt-BR')}</span>
          </div>
          <div class="mt-1">${escapeHtml(f.text)}</div>
        </div>`).join('');
    } catch (e) { console.error('[ADMIN UI] loadFeedback', e); }
  }

  /* ============================================================
     PIPELINE OPERACIONAL (visão master)
     Consome /api/admin/match-debug → mostra contagens por estágio
     (poller / scanner / bot) + lista os matches enriquecidos com o
     motivo de cada drop pelo filtro de sinais.
     ============================================================ */
  const FILTER_REASON_LABELS_ADMIN = {
    confidence_low:   { label: 'CONFIDENCE LOW',   cls: 'warn' },
    market_mismatch:  { label: 'MARKET MISMATCH',  cls: 'muted' },
    profile_filtered: { label: 'PROFILE FILTERED', cls: 'muted' },
    no_edge:          { label: 'NO EDGE',          cls: 'warn' },
    invalid:          { label: 'INVALID',          cls: 'warn' },
  };

  function pipelineBadge(text, cls = 'ok') {
    const colors = {
      ok:    'background:rgba(34,197,94,.16);color:#22c55e;border-color:rgba(34,197,94,.30);',
      warn:  'background:rgba(250,204,21,.16);color:#facc15;border-color:rgba(250,204,21,.30);',
      err:   'background:rgba(239,68,68,.18);color:#fca5a5;border-color:rgba(239,68,68,.30);',
      muted: 'background:var(--surface-2);color:var(--muted);border-color:var(--card-border);',
    };
    return `<span class="badge" style="${colors[cls] || colors.ok} font-size:10px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;border:1px solid;">${escapeHtml(text)}</span>`;
  }

  function renderMasterPipeline(data) {
    const host = document.getElementById('master-pipeline');
    if (!host) return;
    if (!data || (data.ok === false)) {
      host.innerHTML = `<div style="color:var(--muted);font-size:13px;">Pipeline indisponível: ${escapeHtml(data?.error || 'sem dados')}</div>`;
      return;
    }
    const stages = data.stages || {};
    const poller   = stages.poller   || {};
    const liveTick = stages.liveTick || {};
    const bot      = stages.bot      || {};
    const provider = data.provider?.active || liveTick.provider || poller.provider || bot.provider || '—';
    const strict   = String(data.env?.STRICT_REAL_ONLY || '').toLowerCase() === 'true' || !!bot.strict;

    const pollerIn   = poller.beforeFilter ?? poller.scannerIn ?? null;
    const pollerOut  = poller.afterFilter  ?? poller.tracked   ?? null;
    const liveIn     = liveTick.scannerIn  ?? liveTick.beforeFilter ?? null;
    const liveOut    = liveTick.afterConsensus ?? liveTick.afterFreshness ?? liveTick.afterFilter ?? null;
    const botIn      = bot.scannerIn ?? bot.afterCheckFn ?? null;
    const botOut     = bot.finalEmitted ?? bot.afterPreEmit ?? null;
    const filtered   = (botIn != null && botOut != null) ? Math.max(0, botIn - botOut) : null;

    // emitted = matches que sobreviveram TODO o pipeline. drops = mapa
    // id → motivos por estágio. Unimos ambos para mostrar uma linha por
    // match enriquecido — incluindo os que foram filtrados.
    const emitted = Array.isArray(bot.emitted) ? bot.emitted : [];
    const checkFnDrops = Array.isArray(bot.drops?.checkFn) ? bot.drops.checkFn : [];
    const preEmitDrops = Array.isArray(bot.drops?.preEmit) ? bot.drops.preEmit : [];
    const allDrops = [...checkFnDrops, ...preEmitDrops];
    const emittedIds = new Set(emitted.map((m) => String(m.id)));

    const rowsEmitted = emitted.slice(0, 12).map((m) => `
      <tr>
        <td class="py-2 px-3 font-mono" style="font-size:11px;color:var(--muted);">${escapeHtml(String(m.id))}</td>
        <td class="py-2 px-3" style="font-size:12px;">—</td>
        <td class="py-2 px-3 font-mono">${escapeHtml(String(m.status || '—'))}</td>
        <td class="py-2 px-3 font-mono">${m.minute ?? '—'}'</td>
        <td class="py-2 px-3" style="font-size:11px;color:var(--muted);">${escapeHtml(m.provider || provider)}</td>
        <td class="py-2 px-3">${pipelineBadge('OPERÁVEL', 'ok')}</td>
      </tr>
    `).join('');

    const rowsDropped = allDrops
      .filter((d) => !emittedIds.has(String(d.id)))
      .slice(0, 12)
      .map((d) => {
        const reasons = Array.isArray(d.reasons) ? d.reasons : (d.reason ? [d.reason] : []);
        const reasonHtml = reasons.length
          ? reasons.map((r) => {
              const b = FILTER_REASON_LABELS_ADMIN[r] || { label: String(r).toUpperCase(), cls: 'muted' };
              return pipelineBadge(b.label, b.cls);
            }).join(' ')
          : pipelineBadge('FILTRADO', 'muted');
        return `
          <tr style="opacity:.78;">
            <td class="py-2 px-3 font-mono" style="font-size:11px;color:var(--muted);">${escapeHtml(String(d.id || '—'))}</td>
            <td class="py-2 px-3" style="font-size:12px;">${escapeHtml(d.label || d.match || '—')}</td>
            <td class="py-2 px-3 font-mono">${escapeHtml(String(d.status || '—'))}</td>
            <td class="py-2 px-3 font-mono">${d.minute ?? '—'}'</td>
            <td class="py-2 px-3" style="font-size:11px;color:var(--muted);">${escapeHtml(d.provider || provider)}</td>
            <td class="py-2 px-3" style="display:flex;flex-wrap:wrap;gap:4px;">${reasonHtml}</td>
          </tr>`;
      }).join('');

    const tableRows = rowsEmitted + rowsDropped;

    host.innerHTML = `
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px;">
        ${pipelineBadge(`Provider: ${provider}`)}
        ${pollerIn != null ? pipelineBadge(`Poller in: ${pollerIn}`, 'muted') : ''}
        ${pollerOut != null ? pipelineBadge(`Poller out: ${pollerOut}`, 'muted') : ''}
        ${liveIn != null ? pipelineBadge(`Scanner in: ${liveIn}`, 'muted') : ''}
        ${liveOut != null ? pipelineBadge(`Scanner out: ${liveOut}`, 'muted') : ''}
        ${botOut != null ? pipelineBadge(`Operáveis: ${botOut}`) : ''}
        ${filtered != null && filtered > 0 ? pipelineBadge(`Filtrados: ${filtered}`, 'warn') : ''}
        ${strict ? pipelineBadge('STRICT MODE', 'warn') : ''}
      </div>
      ${tableRows ? `
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="table-head">
                <th class="py-2 px-3 text-left">ID</th>
                <th class="py-2 px-3 text-left">Partida</th>
                <th class="py-2 px-3 text-left">Status</th>
                <th class="py-2 px-3 text-left">Min</th>
                <th class="py-2 px-3 text-left">Provider</th>
                <th class="py-2 px-3 text-left">Estado</th>
              </tr>
            </thead>
            <tbody>${tableRows}</tbody>
          </table>
        </div>
      ` : `
        <div style="color:var(--muted);font-size:13px;">
          Pipeline em silêncio — nenhum match enriquecido no último tick do bot.
        </div>
      `}
    `;
  }

  async function loadMasterPipeline() {
    const host = document.getElementById('master-pipeline');
    if (!host) return;
    try {
      const data = await RobotrendAuth.api('/api/admin/match-debug');
      renderMasterPipeline(data);
    } catch (e) {
      host.innerHTML = `<div style="color:var(--muted);font-size:13px;">Pipeline indisponível: ${escapeHtml(e.message || 'erro')}</div>`;
      console.warn('[ADMIN UI] loadMasterPipeline', e);
    }
  }

  document.getElementById('btn-refresh-pipeline')?.addEventListener('click', () => {
    loadMasterPipeline();
  });

  document.getElementById('btn-create-coupon')?.addEventListener('click', async () => {
    const code = (document.getElementById('coup-code')?.value || '').trim().toUpperCase();
    const percent = Number(document.getElementById('coup-percent')?.value || 0);
    await RobotrendAuth.api('/api/beta/coupons', {
      method: 'POST', body: JSON.stringify({ code: code || undefined, percent }),
    });
    const codeEl = document.getElementById('coup-code');
    if (codeEl) codeEl.value = '';
    loadCoupons();
  });

  /** Se tbody ainda está em "Carregando…", tenta render de novo (race com layout). */
  async function retryUsersRenderIfStuck() {
    const stuck = (id) => {
      const el = document.getElementById(id);
      return el && /carregando/i.test(el.textContent || '');
    };
    if (stuck(TBODY_PREMIUM) || stuck(TBODY_FREE) || stuck(TBODY_SUMMARY)) {
      console.warn('[ADMIN UI] tbody ainda em Carregando — retry loadUsers');
      await loadUsers();
    }
  }

  /* Bootstrap: KPIs + CRUD de usuários primeiro; loaders opcionais depois */
  (async function bootstrapAdminPage() {
    await whenDomReady();
    ensureUsersSectionVisible();

    logAdminUi({
      stage: 'bootstrap',
      usersLoaded: false,
      containersFound: probeMounts(),
      rowsRendered: 0,
      mounts: probeMounts(),
      adminJsLoaded: true,
    });
    logAdminRender({ stage: 'bootstrap:start', usersLength: 0, htmlLength: 0 });

    await loadOverview();
    await loadUsers();
    setTimeout(() => { retryUsersRenderIfStuck().catch(() => {}); }, 400);

    await Promise.allSettled([
      loadPayments(),
      loadSignals(),
      loadCoupons(),
      loadFeedback(),
      loadMasterPipeline(),
    ]);

    setInterval(loadOverview, 30000);
    setInterval(() => { loadUsers().catch(() => {}); }, 60000);
    if (document.getElementById('feedback-list')) {
      setInterval(loadFeedback, 60000);
    }
    if (document.getElementById('master-pipeline')) {
      setInterval(() => { loadMasterPipeline().catch(() => {}); }, 8000);
    }
  })();
})();
