/**
 * Robotrend IA — Painel Master (/master)
 */
(function () {
  'use strict';

  const STATUS_CLASS = {
    active: 'st-active',
    expired: 'st-expired',
    blocked: 'st-blocked',
  };
  const STATUS_LABEL = {
    active: 'Ativo',
    expired: 'Expirado',
    blocked: 'Bloqueado',
  };

  function $(id) { return document.getElementById(id); }
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }
  function fmtDate(d) {
    if (!d) return '—';
    try { return new Date(d).toLocaleDateString('pt-BR'); } catch (_) { return '—'; }
  }
  function fmtDateTime(d) {
    if (!d) return '—';
    try { return new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }); } catch (_) { return '—'; }
  }

  let me = null;
  let usersCache = [];

  function statusBadge(status) {
    const s = String(status || 'active').toLowerCase();
    return `<span class="st-badge ${STATUS_CLASS[s] || 'st-active'}">${STATUS_LABEL[s] || s}</span>`;
  }

  function planSelect(user) {
    const p = String(user.plan || 'FREE').toUpperCase();
    return `<select class="master-plan-select input-field" data-id="${user.id}" style="font-size:12px;padding:4px 8px;">
      ${['FREE', 'PREMIUM', 'VIP'].map((x) => `<option value="${x}" ${x === p ? 'selected' : ''}>${x}</option>`).join('')}
    </select>`;
  }

  function renderKpis(users) {
    const total = users.length;
    const active = users.filter((u) => (u.subscriptionStatus || 'active') === 'active' && !u.blocked).length;
    const expired = users.filter((u) => u.subscriptionStatus === 'expired').length;
    const blocked = users.filter((u) => u.blocked || u.subscriptionStatus === 'blocked').length;
    $('kpi-total').textContent = String(total);
    $('kpi-active').textContent = String(active);
    $('kpi-expired').textContent = String(expired);
    $('kpi-blocked').textContent = String(blocked);
  }

  function renderTable(users) {
    const body = $('master-users-body');
    if (!body) return;
    if (!users.length) {
      body.innerHTML = '<tr><td colspan="6" class="py-8 text-center" style="color:var(--muted);">Nenhum usuário encontrado.</td></tr>';
      return;
    }
    body.innerHTML = users.map((u) => {
      const isMe = me && u.id === me.id;
      const blocked = u.blocked || u.subscriptionStatus === 'blocked';
      const days = u.daysRemaining != null ? `${u.daysRemaining}d` : '—';
      return `
        <tr class="${blocked ? 'row-blocked' : ''}" data-user-id="${u.id}">
          <td>
            <div class="font-mono text-xs">${escapeHtml(u.email)}${isMe ? ' <span style="color:#14b85e">(você)</span>' : ''}</div>
            <div class="text-xs" style="color:var(--muted);">${escapeHtml(u.name || '—')}</div>
          </td>
          <td>${planSelect(u)}</td>
          <td>${statusBadge(u.subscriptionStatus)}${blocked && u.blockedReason ? `<div class="text-xs" style="color:var(--muted);margin-top:4px;">${escapeHtml(u.blockedReason)}</div>` : ''}</td>
          <td>
            <div>${fmtDate(u.expiresAt)}</div>
            <div class="text-xs" style="color:var(--muted);">${days !== '—' ? days + ' restantes' : ''}</div>
          </td>
          <td class="text-xs" style="color:var(--muted);">${fmtDate(u.createdAt)}</td>
          <td>
            <div class="act-group">
              <button type="button" class="btn-xs ok btn-save-plan" data-id="${u.id}">Salvar plano</button>
              <button type="button" class="btn-xs ok btn-renew" data-id="${u.id}" data-plan="${escapeHtml(u.plan)}">Renovar</button>
              ${isMe ? '' : (blocked
                ? `<button type="button" class="btn-xs ok btn-unblock" data-id="${u.id}">Desbloquear</button>`
                : `<button type="button" class="btn-xs warn btn-block" data-id="${u.id}">Bloquear</button>`)}
              ${isMe ? '' : `<button type="button" class="btn-xs danger btn-delete" data-id="${u.id}" data-email="${escapeHtml(u.email)}">Excluir</button>`}
            </div>
          </td>
        </tr>`;
    }).join('');
    wireActions(body);
  }

  function wireActions(body) {
    body.querySelectorAll('.btn-save-plan').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const plan = body.querySelector(`.master-plan-select[data-id="${id}"]`)?.value;
        try {
          btn.disabled = true;
          await RobotrendAuth.api(`/api/master/users/${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ plan }),
          });
          await loadUsers();
          await loadLogs();
        } catch (e) { alert(e.message); }
        finally { btn.disabled = false; }
      });
    });

    body.querySelectorAll('.btn-block').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const reason = prompt('Motivo do bloqueio (opcional):') || '';
        if (!confirm('Bloquear este usuário?')) return;
        try {
          await RobotrendAuth.api(`/api/master/users/${id}/block`, {
            method: 'POST',
            body: JSON.stringify({ reason }),
          });
          await loadUsers();
          await loadLogs();
        } catch (e) { alert(e.message); }
      });
    });

    body.querySelectorAll('.btn-unblock').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        if (!confirm('Desbloquear este usuário?')) return;
        try {
          await RobotrendAuth.api(`/api/master/users/${id}/unblock`, { method: 'POST' });
          await loadUsers();
          await loadLogs();
        } catch (e) { alert(e.message); }
      });
    });

    body.querySelectorAll('.btn-renew').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const plan = (body.querySelector(`.master-plan-select[data-id="${id}"]`)?.value || btn.dataset.plan || 'PREMIUM').toUpperCase();
        if (!['PREMIUM', 'VIP'].includes(plan)) {
          alert('Renovação disponível apenas para Premium (+180d) ou VIP (+365d).');
          return;
        }
        const days = plan === 'VIP' ? 365 : 180;
        if (!confirm(`Renovar ${plan} por +${days} dias?`)) return;
        try {
          await RobotrendAuth.api(`/api/master/users/${id}/renew`, {
            method: 'POST',
            body: JSON.stringify({ plan }),
          });
          await loadUsers();
          await loadLogs();
        } catch (e) { alert(e.message); }
      });
    });

    body.querySelectorAll('.btn-delete').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const email = btn.dataset.email;
        if (!confirm(`Excluir permanentemente ${email}?`)) return;
        try {
          await RobotrendAuth.api(`/api/master/users/${id}`, { method: 'DELETE' });
          await loadUsers();
          await loadLogs();
        } catch (e) { alert(e.message); }
      });
    });
  }

  async function loadUsers() {
    const statusEl = $('master-status');
    try {
      const q = ($('filter-q')?.value || '').trim();
      const plan = $('filter-plan')?.value || '';
      const st = $('filter-status')?.value || '';
      const qs = new URLSearchParams();
      if (q) qs.set('q', q);
      if (plan) qs.set('plan', plan);
      if (st) qs.set('status', st);
      qs.set('limit', '300');
      const data = await RobotrendAuth.api(`/api/master/users?${qs}`);
      usersCache = data.users || [];
      renderKpis(usersCache);
      renderTable(usersCache);
      if (statusEl) {
        statusEl.textContent = `✓ ${usersCache.length} usuário(s) listado(s)`;
        statusEl.style.color = '#14b85e';
      }
    } catch (e) {
      if (statusEl) {
        statusEl.textContent = `Erro: ${e.message}`;
        statusEl.style.color = '#ff6677';
      }
      $('master-users-body').innerHTML = `<tr><td colspan="6" class="py-8 text-center" style="color:#ff6677;">${escapeHtml(e.message)}</td></tr>`;
    }
  }

  async function loadLogs() {
    const el = $('master-logs');
    if (!el) return;
    try {
      const { logs } = await RobotrendAuth.api('/api/master/logs?limit=40');
      const list = Array.isArray(logs) ? logs : [];
      if (!list.length) {
        el.innerHTML = '<div style="color:var(--muted);font-size:13px;">Nenhuma ação registrada ainda.</div>';
        return;
      }
      el.innerHTML = list.map((l) => {
        const at = l.created_at || l.createdAt;
        const action = l.action || '—';
        const target = l.target_email || l.target_user_id || '—';
        return `<div style="padding:8px 0;border-bottom:1px solid var(--line);font-size:12px;">
          <span style="color:var(--muted);">${fmtDateTime(at)}</span>
          <b style="color:#14b85e;margin:0 6px;">${escapeHtml(action)}</b>
          <span>${escapeHtml(target)}</span>
          ${l.admin_email ? `<span style="color:var(--muted);"> · por ${escapeHtml(l.admin_email)}</span>` : ''}
        </div>`;
      }).join('');
    } catch (e) {
      el.innerHTML = `<div style="color:#ff6677;">${escapeHtml(e.message)}</div>`;
    }
  }

  /* ============================================================
     Consumo API-Football — conecta ao MESMO endpoint do Painel Técnico
     (GET /api/admin/api-usage). admin/master têm acesso (requireAdmin).
     ============================================================ */
  function fmtNum(n) {
    return n == null || isNaN(n) ? '—' : Number(n).toLocaleString('pt-BR');
  }

  function muBarChart(el, data, color, maxLabels) {
    if (!el) return;
    const arr = data || [];
    const vals = arr.map((d) => Number(d.total) || 0);
    const max = Math.max(1, ...vals);
    const n = arr.length || 1;
    const step = Math.max(1, Math.ceil(n / (maxLabels || 8)));
    const bars = arr.map((d, i) => {
      const v = Number(d.total) || 0;
      const pct = Math.round((v / max) * 100);
      const show = (i % step === 0) || i === n - 1;
      return `<div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;min-width:0">
        <div title="${escapeHtml(d.label)}: ${v}" style="width:78%;height:${pct}%;min-height:1px;background:${color};border-radius:2px 2px 0 0"></div>
        <div style="font-size:8px;color:var(--muted);margin-top:2px;white-space:nowrap;overflow:hidden;max-width:100%">${show ? escapeHtml(d.label) : ''}</div>
      </div>`;
    }).join('');
    el.innerHTML = `<div style="display:flex;align-items:flex-end;gap:2px;height:110px">${bars}</div>`;
  }

  async function loadApiUsage() {
    const note = $('mu-note');
    try {
      const d = await RobotrendAuth.api('/api/admin/api-usage');
      if (!d || typeof d !== 'object' || d.ok !== true) {
        const hint = typeof d === 'string'
          ? `Resposta não-JSON (${d.slice(0, 80)}…) — rota /api/admin/api-usage pode não estar no deploy.`
          : `Resposta inválida: ok=${d?.ok ?? 'ausente'} — verifique deploy do backend.`;
        console.warn('[loadApiUsage]', hint, d);
        if (note) note.textContent = hint;
        return;
      }
      const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
      set('mu-today', fmtNum(d.callsToday));
      set('mu-hour', fmtNum(d.callsLastHour));
      set('mu-consumed', fmtNum(d.credits?.consumed));
      set('mu-remaining', d.credits?.remaining == null ? '—' : fmtNum(d.credits.remaining));
      set('mu-games', fmtNum(d.gamesMonitored));
      set('mu-poller', fmtNum(d.consumption?.poller));
      set('mu-enricher', fmtNum(d.consumption?.enricher));
      set('mu-route', fmtNum(d.consumption?.route));
      set('mu-avg', fmtNum(d.report?.avgDaily));
      set('mu-monthly', fmtNum(d.report?.monthlyProjection));

      const riskEl = $('mu-risk');
      if (riskEl) {
        const lvl = d.report?.riskLevel || '—';
        const pct = d.report?.riskRatio != null ? ` (${Math.round(d.report.riskRatio * 100)}%)` : '';
        riskEl.textContent = lvl + pct;
        riskEl.style.color = (lvl === 'CRÍTICO' || lvl === 'ALTO') ? '#ff6677'
          : lvl === 'MODERADO' ? '#ffb547' : '#14b85e';
      }

      muBarChart($('mu-chart-hourly'), d.charts?.hourly, '#06b6d4', 8);
      muBarChart($('mu-chart-daily'), d.charts?.daily, '#a855f7', 10);

      if (note) {
        const limit = d.credits?.limit;
        note.textContent = limit
          ? `Limite do plano: ${fmtNum(limit)}/dia.` + (d.safeMode ? ' ⚠️ SAFE-MODE ativo — enricher pausado.' : '')
          : 'Limite ainda não reportado pela API — usando rate-limiter local.';
      }
    } catch (e) {
      console.warn('[loadApiUsage] erro', e.status, e.message, e.payload);
      if (note) {
        note.textContent = e.status === 404
          ? 'Endpoint /api/admin/api-usage não encontrado (404) — faça deploy do backend com apiUsageTracker.'
          : `Falha ao carregar consumo: HTTP ${e.status || '?'} — ${e.message}`;
      }
    }
  }

  async function loadYoutubeClicks() {
    const el = $('kpi-youtube-clicks');
    if (!el) return;
    try {
      const data = await RobotrendAuth.api('/api/master/youtube-clicks');
      el.textContent = String(data.total ?? 0);
    } catch (e) {
      console.warn('[loadYoutubeClicks]', e.message);
      el.textContent = '—';
    }
  }

  async function boot() {
    try {
      if (window.RobotrendGuard?.ready) me = await RobotrendGuard.ready;
      else me = (await RobotrendAuth.api('/api/auth/me'))?.user;
    } catch (_) {}
    $('btn-filter')?.addEventListener('click', loadUsers);
    $('filter-q')?.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') loadUsers(); });
    $('btn-refresh')?.addEventListener('click', () => { loadUsers(); loadLogs(); loadApiUsage(); loadYoutubeClicks(); });
    await loadUsers();
    await loadLogs();
    loadApiUsage();
    loadYoutubeClicks();
    setInterval(loadUsers, 60000);
    setInterval(loadApiUsage, 30000);
    setInterval(loadYoutubeClicks, 30000);
  }

  if (window.RobotrendGuard?.ready) {
    RobotrendGuard.ready.then(boot);
  } else {
    boot();
  }
})();
