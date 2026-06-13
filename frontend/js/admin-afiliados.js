/* Robotrend IA — Gestão de Afiliados (admin/master)
   O auth-guard.js (meta robotrend-guard="admin") já bloqueia não-admins.
*/
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  let cache = [];
  const expanded = new Set();
  const details = new Map(); // affiliateId -> { commissions, payouts }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function money(v) {
    return 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',');
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function feedback(msg, ok = true) {
    const el = $('#af-feedback');
    if (!el) return;
    el.style.display = 'block';
    el.style.color = ok ? 'var(--brand,#14b85e)' : 'var(--danger,#ef4444)';
    el.textContent = msg;
    if (ok) setTimeout(() => { el.style.display = 'none'; }, 4000);
  }

  /* ---------------- overview ---------------- */
  async function loadOverview() {
    try {
      const { overview } = await RobotrendAuth.api('/api/master/affiliates-overview');
      $('#ov-affiliates').textContent = overview.totalAffiliates;
      $('#ov-referrals').textContent = overview.totalReferrals;
      $('#ov-premium').textContent = overview.totalPremium;
      $('#ov-revenue').textContent = money(overview.revenueGenerated);
      $('#ov-pending').textContent = money(overview.pendingCommissions);
      $('#ov-paid').textContent = money(overview.paidCommissions);
    } catch (_) { /* mantém placeholders */ }
  }

  /* ---------------- list ---------------- */
  function rowHtml(a) {
    const st = a.stats || {};
    const isOpen = expanded.has(a.id);
    const main = `
      <tr style="border-top:1px solid var(--line);" data-row="${escapeHtml(a.id)}">
        <td class="py-3 px-4">
          <div style="font-weight:800;">${escapeHtml(a.name)}</div>
          <div style="color:var(--muted); font-size:12px;">${escapeHtml(a.email || '—')}</div>
        </td>
        <td class="py-3 px-4">
          <div class="af-code">${escapeHtml(a.code)}</div>
          <button class="af-btn" data-act="copy" data-id="${escapeHtml(a.id)}" style="margin-top:4px;">Copiar link</button>
        </td>
        <td class="py-3 px-4">
          <input class="af-pct-input" type="number" min="0" step="0.01" value="${Number(a.commissionPct)}" data-pct="${escapeHtml(a.id)}" />
          <span style="color:var(--muted);">%</span>
        </td>
        <td class="py-3 px-4">${st.referrals ?? 0}</td>
        <td class="py-3 px-4" style="color:var(--brand,#14b85e); font-weight:700;">${st.premiumActive ?? 0}</td>
        <td class="py-3 px-4 af-money">${money(st.revenueGenerated)}</td>
        <td class="py-3 px-4 af-money" style="color:#ffb547;">${money(st.pending)}</td>
        <td class="py-3 px-4 af-money" style="color:var(--brand,#14b85e);">${money(st.paid)}</td>
        <td class="py-3 px-4"><span class="af-status ${a.active ? 'af-on' : 'af-off'}">${a.active ? 'Ativo' : 'Inativo'}</span></td>
        <td class="py-3 px-4">
          <div style="display:flex; gap:6px; flex-wrap:wrap;">
            <button class="af-btn brand" data-act="save-pct" data-id="${escapeHtml(a.id)}">Salvar %</button>
            <button class="af-btn" data-act="pay" data-id="${escapeHtml(a.id)}">Pagar pendente</button>
            <button class="af-btn" data-act="toggle" data-id="${escapeHtml(a.id)}">${a.active ? 'Desativar' : 'Ativar'}</button>
            <button class="af-btn" data-act="details" data-id="${escapeHtml(a.id)}">${isOpen ? 'Ocultar' : 'Detalhes'}</button>
          </div>
        </td>
      </tr>`;
    const detail = isOpen ? detailHtml(a.id) : '';
    return main + detail;
  }

  function detailHtml(id) {
    const d = details.get(id);
    if (!d) {
      return `<tr class="af-detail"><td colspan="10"><div style="padding:14px;color:var(--muted);">Carregando histórico…</div></td></tr>`;
    }
    const comm = (d.commissions || []).map((c) => `
      <tr>
        <td>${escapeHtml(fmtDate(c.createdAt))}</td>
        <td>${escapeHtml(c.plan || '—')}</td>
        <td class="af-money">${money(c.amountPaid)}</td>
        <td>${Number(c.commissionPct)}%</td>
        <td class="af-money">${money(c.commissionAmount)}</td>
        <td><span class="af-pill ${c.status}">${c.status === 'paid' ? 'Paga' : 'Pendente'}</span></td>
      </tr>`).join('') || `<tr><td colspan="6" style="color:var(--muted);">Nenhuma comissão ainda.</td></tr>`;

    const pays = (d.payouts || []).map((p) => `
      <tr>
        <td>${escapeHtml(fmtDate(p.createdAt))}</td>
        <td class="af-money">${money(p.amount)}</td>
        <td>${p.commissionsCount} comissão(ões)</td>
        <td>${escapeHtml(p.note || '—')}</td>
      </tr>`).join('') || `<tr><td colspan="4" style="color:var(--muted);">Nenhum pagamento registrado.</td></tr>`;

    return `
      <tr class="af-detail"><td colspan="10">
        <div style="padding:14px; display:grid; gap:16px;">
          <div>
            <div style="font-weight:800; margin-bottom:6px;">Histórico de comissões</div>
            <table class="af-sub">
              <thead><tr><th>Data</th><th>Plano</th><th>Valor pago</th><th>%</th><th>Comissão</th><th>Status</th></tr></thead>
              <tbody>${comm}</tbody>
            </table>
          </div>
          <div>
            <div style="font-weight:800; margin-bottom:6px;">Pagamentos ao afiliado</div>
            <table class="af-sub">
              <thead><tr><th>Data</th><th>Valor</th><th>Comissões</th><th>Obs.</th></tr></thead>
              <tbody>${pays}</tbody>
            </table>
          </div>
        </div>
      </td></tr>`;
  }

  function render() {
    const body = $('#af-body');
    $('#af-count').textContent = cache.length;
    if (!cache.length) {
      body.innerHTML = `<tr><td colspan="10" class="py-6 text-center" style="color:var(--muted);">Nenhum afiliado cadastrado.</td></tr>`;
      return;
    }
    body.innerHTML = cache.map(rowHtml).join('');
  }

  async function load() {
    try {
      const data = await RobotrendAuth.api('/api/master/affiliates');
      cache = data.affiliates || [];
      render();
    } catch (e) {
      $('#af-body').innerHTML = `<tr><td colspan="10" class="py-6 text-center" style="color:var(--danger,#ef4444);">Erro: ${escapeHtml(e.message)}</td></tr>`;
    }
  }

  async function loadDetails(id) {
    try {
      const data = await RobotrendAuth.api(`/api/master/affiliates/${encodeURIComponent(id)}`);
      details.set(id, { commissions: data.commissions || [], payouts: data.payouts || [] });
    } catch (_) {
      details.set(id, { commissions: [], payouts: [] });
    }
    render();
  }

  /* ---------------- create ---------------- */
  $('#form-affiliate')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      name: $('#af-name').value.trim(),
      email: $('#af-email').value.trim().toLowerCase(),
      password: $('#af-password').value.trim() || undefined,
      commissionPct: Number($('#af-pct').value),
    };
    if (!payload.name || !payload.email) return feedback('Preencha nome e e-mail.', false);
    if (Number.isNaN(payload.commissionPct) || payload.commissionPct < 0) return feedback('Informe um percentual válido.', false);

    try {
      const r = await RobotrendAuth.api('/api/master/affiliates', { method: 'POST', body: JSON.stringify(payload) });
      $('#form-affiliate').reset();
      feedback('Afiliado criado com sucesso.');
      const acc = $('#af-access');
      if (r.access && r.access.password) {
        acc.style.display = 'block';
        acc.innerHTML = `Conta de acesso criada para <code>${escapeHtml(r.access.email)}</code> · senha provisória: <code>${escapeHtml(r.access.password)}</code><br/>O afiliado faz login em <code>/login.html</code> e cai no painel do afiliado. Anote a senha — ela não será exibida novamente.`;
      } else {
        acc.style.display = 'block';
        acc.innerHTML = `Conta existente <code>${escapeHtml(r.access?.email || payload.email)}</code> vinculada como afiliado. Ela usa a senha atual para login.`;
      }
      load();
      loadOverview();
    } catch (err) {
      const code = err?.payload?.error || err.message;
      let msg = `Erro ao criar afiliado: ${code}`;
      if (code === 'EMAIL_IS_ADMIN') msg = 'Este e-mail pertence a um administrador e não pode virar afiliado.';
      else if (code === 'ALREADY_AFFILIATE') msg = 'Este usuário já é um afiliado.';
      else if (code === 'INVALID_EMAIL') msg = 'E-mail inválido.';
      else if (code === 'INVALID_COMMISSION') msg = 'Percentual de comissão inválido.';
      feedback(msg, false);
    }
  });

  /* ---------------- table actions ---------------- */
  $('#af-body')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.dataset.id;
    const act = btn.dataset.act;
    const item = cache.find((x) => String(x.id) === String(id));
    if (!item) return;

    try {
      if (act === 'copy') {
        const link = item.link || `${location.origin}/register.html?ref=${item.code}`;
        try { await navigator.clipboard.writeText(link); feedback('Link copiado: ' + link); }
        catch { prompt('Copie o link de indicação:', link); }
      } else if (act === 'save-pct') {
        const input = document.querySelector(`input[data-pct="${CSS.escape(id)}"]`);
        const pct = Number(input?.value);
        if (Number.isNaN(pct) || pct < 0) return feedback('Percentual inválido.', false);
        await RobotrendAuth.api(`/api/master/affiliates/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ commissionPct: pct }) });
        feedback(`Comissão de ${item.name} atualizada para ${pct}%.`);
        load();
      } else if (act === 'toggle') {
        await RobotrendAuth.api(`/api/master/affiliates/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ active: !item.active }) });
        load();
      } else if (act === 'pay') {
        const st = item.stats || {};
        if (!st.pending) return feedback('Não há comissões pendentes para este afiliado.', false);
        if (!confirm(`Marcar ${money(st.pending)} em comissões como PAGAS para ${item.name}?`)) return;
        const r = await RobotrendAuth.api(`/api/master/affiliates/${encodeURIComponent(id)}/pay`, { method: 'POST', body: JSON.stringify({}) });
        feedback(`Pagamento registrado: ${money(r.amount)} (${r.count} comissão(ões)).`);
        details.delete(id);
        if (expanded.has(id)) loadDetails(id);
        load();
        loadOverview();
      } else if (act === 'details') {
        if (expanded.has(id)) {
          expanded.delete(id);
          render();
        } else {
          expanded.add(id);
          render();
          loadDetails(id);
        }
      }
    } catch (err) {
      feedback(`Erro: ${err?.payload?.error || err.message}`, false);
    }
  });

  load();
  loadOverview();
})();
