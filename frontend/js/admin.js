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
  if (!me) return;

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

  async function loadOverview() {
    try {
      const o = await RobotrendAuth.api('/api/admin/overview');
      setText('kpi-users',   o.users ?? '—');
      setText('kpi-revenue', 'R$ ' + (Number(o.revenue) || 0).toFixed(2));
      setText('kpi-signals', o.signals ?? '—');
      setText('kpi-winrate', (o.signalsStats?.winrate ?? 0) + '%');
      // kpi-free, kpi-premium, kpi-conversion → preenchidos por loadUsers()
    } catch (e) { console.error(e); }
  }

  function planBadge(plan, role) {
    if (role === 'admin' || role === 'owner') return '<span class="plan-badge admin">ADMIN</span>';
    if (plan === 'PREMIUM' || role === 'premium') return '<span class="plan-badge premium">💎 PREMIUM</span>';
    if (plan === 'VIP') return '<span class="plan-badge vip">VIP</span>';
    return '<span class="plan-badge free">FREE</span>';
  }
  function statusBadge(active) {
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
  async function loadUsers() {
    try {
      const { users } = await RobotrendAuth.api('/api/admin/users');

      // ---- Separação por categoria ----
      const admins  = users.filter(u => u.role === 'admin' || u.role === 'owner');
      const nonAdmin = users.filter(u => u.role !== 'admin' && u.role !== 'owner');
      const premium = nonAdmin.filter(u => u.plan === 'PREMIUM' || u.plan === 'VIP' || u.role === 'premium');
      const free    = nonAdmin.filter(u => !(u.plan === 'PREMIUM' || u.plan === 'VIP' || u.role === 'premium'));

      // ---- KPIs ----
      const totalClients = nonAdmin.length;
      const conversionPct = totalClients > 0 ? ((premium.length / totalClients) * 100) : 0;
      const revenueEstimate = premium.length * PREMIUM_PRICE;

      const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
      setText('kpi-free',       String(free.length));
      setText('kpi-premium',    String(premium.length));
      setText('kpi-conversion', conversionPct.toFixed(1) + '%');
      setText('premium-count',  String(premium.length));
      setText('premium-revenue','R$ ' + revenueEstimate.toFixed(2).replace('.', ','));
      setText('free-count',     String(free.length));
      setText('free-conversion', conversionPct.toFixed(1) + '%');
      setText('admin-count',    String(admins.length));

      renderPremiumTable(premium);
      renderFreeTable(free);
      renderAdminTable(admins);

      // mostra a seção de admins apenas se houver mais de 1
      const adminsSection = document.getElementById('admins-section');
      if (adminsSection) adminsSection.style.display = admins.length > 1 ? '' : 'none';
    } catch (e) { console.error('loadUsers', e); }
  }

  /* ---------- PREMIUM TABLE ---------- */
  function renderPremiumTable(users) {
    const body = document.getElementById('premium-body');
    if (!body) return;
    if (!users.length) {
      body.innerHTML = `<tr><td colspan="7" class="py-6 text-center" style="color:var(--muted);">Nenhum cliente PREMIUM ainda. 💎</td></tr>`;
      return;
    }
    body.innerHTML = users.map(u => {
      const isMe = u.id === me.id;
      const active = !!(u.plan === 'PREMIUM' || u.plan === 'VIP'); // todos aqui são ativos por definição
      return `
        <tr data-user-id="${u.id}">
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
          <td class="py-3 px-4">${statusBadge(active)}</td>
          <td class="py-3 px-4">
            <div class="flex gap-1 flex-wrap">
              <button class="btn-ghost btn-save text-xs" data-id="${u.id}">Salvar</button>
              <button class="btn-ghost btn-reset-pw text-xs" data-id="${u.id}" data-email="${escapeHtml(u.email)}">Senha</button>
              ${isMe ? '' : `<button class="btn-ghost btn-del text-xs" data-id="${u.id}" data-email="${escapeHtml(u.email)}" style="color:#ff6677;">Remover</button>`}
            </div>
          </td>
        </tr>`;
    }).join('');
    wireRowActions(body);
  }

  /* ---------- FREE TABLE ---------- */
  function renderFreeTable(users) {
    const body = document.getElementById('free-body');
    if (!body) return;
    if (!users.length) {
      body.innerHTML = `<tr><td colspan="6" class="py-6 text-center" style="color:var(--muted);">Sem clientes FREE no momento.</td></tr>`;
      return;
    }
    body.innerHTML = users.map(u => {
      const lastSeen = u.updatedAt || u.lastSeenAt || u.createdAt;
      return `
        <tr data-user-id="${u.id}">
          <td class="py-3 px-4 font-mono text-xs">${escapeHtml(u.email)}</td>
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
              <button class="btn-ghost btn-del text-xs" data-id="${u.id}" data-email="${escapeHtml(u.email)}" style="color:#ff6677;">Remover</button>
            </div>
          </td>
        </tr>`;
    }).join('');
    wireRowActions(body);

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
  }

  /* ---------- ADMIN TABLE ---------- */
  function renderAdminTable(users) {
    const body = document.getElementById('admin-body');
    if (!body) return;
    if (!users.length) {
      body.innerHTML = `<tr><td colspan="5" class="py-6 text-center" style="color:var(--muted);">—</td></tr>`;
      return;
    }
    body.innerHTML = users.map(u => {
      const isMe = u.id === me.id;
      return `
        <tr data-user-id="${u.id}">
          <td class="py-3 px-4 font-mono text-xs">${escapeHtml(u.email)}${isMe ? ' <span style="color:var(--brand);">(você)</span>' : ''}</td>
          <td class="py-3 px-4">${escapeHtml(u.name || '—')}</td>
          <td class="py-3 px-4">${planBadge(u.plan, u.role)}</td>
          <td class="py-3 px-4 text-xs" style="color: var(--muted);">${fmtDate(u.createdAt)}</td>
          <td class="py-3 px-4">
            <div class="flex gap-1 flex-wrap">
              <button class="btn-ghost btn-reset-pw text-xs" data-id="${u.id}" data-email="${escapeHtml(u.email)}">Senha</button>
              ${isMe ? '' : `<button class="btn-ghost btn-del text-xs" data-id="${u.id}" data-email="${escapeHtml(u.email)}" style="color:#ff6677;">Remover</button>`}
            </div>
          </td>
        </tr>`;
    }).join('');
    wireRowActions(body);
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
    try {
      const { payments } = await RobotrendAuth.api('/api/admin/payments');
      const body = document.getElementById('payments-body');
      if (!payments.length) { body.innerHTML = `<tr><td colspan="5" class="py-6 text-center" style="color:var(--muted);">Sem pagamentos</td></tr>`; return; }
      body.innerHTML = payments.map(p => `
        <tr>
          <td class="py-3 px-4 font-mono text-xs">${new Date(p.created_at).toLocaleString('pt-BR')}</td>
          <td class="py-3 px-4">${p.provider}</td>
          <td class="py-3 px-4">${p.plan}</td>
          <td class="py-3 px-4 font-mono">R$ ${Number(p.amount_brl || p.amount || 0).toFixed(2)}</td>
          <td class="py-3 px-4"><span class="badge ${p.status === 'paid' ? 'win' : ''}">${p.status}</span></td>
        </tr>
      `).join('');
    } catch (e) { console.error(e); }
  }

  async function loadSignals() {
    try {
      const { signals } = await RobotrendAuth.api('/api/admin/signals');
      const body = document.getElementById('signals-body');
      if (!signals.length) { body.innerHTML = `<tr><td colspan="6" class="py-6 text-center" style="color:var(--muted);">Sem sinais</td></tr>`; return; }
      body.innerHTML = signals.slice(0, 50).map(s => {
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
    } catch (e) { console.error(e); }
  }

  async function loadCoupons() {
    try {
      const { coupons } = await RobotrendAuth.api('/api/beta/coupons');
      const el = document.getElementById('coupons-list');
      if (!coupons.length) { el.innerHTML = '<span style="color:var(--muted);">Nenhum cupom criado.</span>'; return; }
      el.innerHTML = coupons.map(c => `
        <div class="flex justify-between py-1" style="border-bottom: 1px solid var(--card-border);">
          <code style="background: var(--bg-2); padding: 2px 6px; border-radius: 3px;">${c.code}</code>
          <span>-${c.value}% · ${c.used}/${c.maxUses} usos</span>
        </div>`).join('');
    } catch (e) { console.error(e); }
  }
  async function loadFeedback() {
    try {
      const r = await RobotrendAuth.api('/api/beta/feedback');
      const stats = r.stats;
      document.getElementById('feedback-stats').textContent =
        `${stats.count} mensagens · Nota média: ${stats.avgRating}/5`;
      const el = document.getElementById('feedback-list');
      if (!r.feedback.length) { el.innerHTML = '<span style="color:var(--muted);">Nenhum feedback ainda.</span>'; return; }
      el.innerHTML = r.feedback.slice(0, 100).map(f => `
        <div class="card" style="padding: 10px;">
          <div class="flex justify-between text-xs" style="color: var(--muted);">
            <span>${f.email || 'anônimo'}</span>
            <span>${'★'.repeat(f.rating)}${'☆'.repeat(5 - f.rating)} · ${new Date(f.createdAt).toLocaleString('pt-BR')}</span>
          </div>
          <div class="mt-1">${f.text}</div>
        </div>`).join('');
    } catch (e) { console.error(e); }
  }

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

  loadOverview();
  loadUsers();
  loadPayments();
  loadSignals();
  loadCoupons();
  loadFeedback();
  setInterval(loadOverview, 30000);
  setInterval(loadFeedback, 60000);
})();
