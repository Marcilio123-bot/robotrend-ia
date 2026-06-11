/* Robotrend IA — Gestão de Avisos (admin/master)
   O auth-guard.js (meta robotrend-guard="admin") já bloqueia não-admins.
*/
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function feedback(msg, ok = true) {
    const el = $('#av-feedback');
    if (!el) return;
    el.style.display = 'block';
    el.style.color = ok ? 'var(--brand,#14b85e)' : 'var(--danger,#ef4444)';
    el.textContent = msg;
    if (ok) setTimeout(() => { el.style.display = 'none'; }, 3000);
  }

  function resetForm() {
    $('#av-id').value = '';
    $('#av-title').value = '';
    $('#av-message').value = '';
    $('#av-active').checked = true;
    $('#form-title').textContent = '+ Novo aviso';
    $('#av-submit').textContent = '+ Criar aviso';
    $('#av-cancel').style.display = 'none';
  }

  function startEdit(a) {
    $('#av-id').value = a.id;
    $('#av-title').value = a.title || '';
    $('#av-message').value = a.message || '';
    $('#av-active').checked = !!a.active;
    $('#form-title').textContent = `✎ Editar aviso #${a.id}`;
    $('#av-submit').textContent = 'Salvar alterações';
    $('#av-cancel').style.display = 'inline-block';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  let cache = [];

  function render(list) {
    cache = list;
    const body = $('#av-body');
    $('#av-count').textContent = list.length;
    if (!list.length) {
      body.innerHTML = `<tr><td colspan="5" class="py-6 text-center" style="color:var(--muted);">Nenhum aviso cadastrado.</td></tr>`;
      return;
    }
    body.innerHTML = list.map((a) => `
      <tr style="border-top:1px solid var(--line);">
        <td class="py-3 px-4" style="font-weight:700;">${escapeHtml(a.title)}</td>
        <td class="py-3 px-4"><div class="av-msg">${escapeHtml(a.message)}</div></td>
        <td class="py-3 px-4"><span class="av-status ${a.active ? 'av-on' : 'av-off'}">${a.active ? 'Ativo' : 'Inativo'}</span></td>
        <td class="py-3 px-4" style="color:var(--muted);">${fmtDate(a.createdAt)}</td>
        <td class="py-3 px-4">
          <div class="av-actions">
            <button class="av-btn" data-act="toggle" data-id="${a.id}">${a.active ? 'Desativar' : 'Ativar'}</button>
            <button class="av-btn" data-act="edit" data-id="${a.id}">Editar</button>
            <button class="av-btn danger" data-act="delete" data-id="${a.id}">Excluir</button>
          </div>
        </td>
      </tr>`).join('');
  }

  async function load() {
    try {
      const data = await RobotrendAuth.api('/api/master/announcements');
      render(data.announcements || []);
    } catch (e) {
      $('#av-body').innerHTML = `<tr><td colspan="5" class="py-6 text-center" style="color:var(--danger,#ef4444);">Erro: ${escapeHtml(e.message)}</td></tr>`;
    }
  }

  $('#form-announcement')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('#av-id').value;
    const payload = {
      title: $('#av-title').value.trim(),
      message: $('#av-message').value.trim(),
      active: $('#av-active').checked,
    };
    if (!payload.title || !payload.message) {
      return feedback('Preencha título e mensagem.', false);
    }
    try {
      if (id) {
        await RobotrendAuth.api(`/api/master/announcements/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
        feedback('Aviso atualizado com sucesso.');
      } else {
        await RobotrendAuth.api('/api/master/announcements', { method: 'POST', body: JSON.stringify(payload) });
        feedback('Aviso criado com sucesso.');
      }
      resetForm();
      load();
    } catch (err) {
      feedback(`Erro ao salvar: ${err.message}`, false);
    }
  });

  $('#av-cancel')?.addEventListener('click', resetForm);

  $('#av-body')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.dataset.id;
    const act = btn.dataset.act;
    const item = cache.find((x) => String(x.id) === String(id));
    if (!item) return;

    try {
      if (act === 'edit') {
        startEdit(item);
      } else if (act === 'toggle') {
        await RobotrendAuth.api(`/api/master/announcements/${id}`, { method: 'PATCH', body: JSON.stringify({ active: !item.active }) });
        load();
      } else if (act === 'delete') {
        if (!confirm(`Excluir o aviso "${item.title}"?`)) return;
        await RobotrendAuth.api(`/api/master/announcements/${id}`, { method: 'DELETE' });
        feedback('Aviso excluído.');
        load();
      }
    } catch (err) {
      feedback(`Erro: ${err.message}`, false);
    }
  });

  load();
})();
