/* Robotrend IA — Suporte (admin/master)
   Lista as conversas dos usuários e permite responder.
   O auth-guard.js (meta robotrend-guard="admin") já bloqueia não-admins.
*/
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);

  let threads = [];
  let activeUserId = null;
  let activeThread = null;
  let sending = false;

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function displayName(t) {
    return t.userName || (t.userEmail ? t.userEmail.split('@')[0] : (t.userId ? `Usuário ${String(t.userId).slice(0, 6)}` : 'Usuário'));
  }

  function initial(t) {
    const n = displayName(t);
    return (n[0] || '?').toUpperCase();
  }

  function renderThreads() {
    const host = $('#sup-threads');
    $('#sup-thread-count').textContent = threads.length;
    const totalUnread = threads.reduce((s, t) => s + (Number(t.unread) || 0), 0);
    $('#sup-unread-total').textContent = totalUnread;

    if (!threads.length) {
      host.innerHTML = `<div class="sup-placeholder" style="height:auto; padding:24px;">Nenhuma mensagem de suporte ainda.</div>`;
      return;
    }

    host.innerHTML = threads.map((t) => {
      const last = (t.lastSender === 'admin' ? 'Você: ' : '') + (t.lastMessage || '');
      return `
        <button class="sup-thread ${String(t.userId) === String(activeUserId) ? 'active' : ''}" data-user="${escapeHtml(t.userId)}">
          <div class="sup-thread-ava">${escapeHtml(initial(t))}</div>
          <div class="sup-thread-meta">
            <div class="sup-thread-name">${escapeHtml(displayName(t))}</div>
            <div class="sup-thread-last">${escapeHtml(last)}</div>
          </div>
          <div class="sup-thread-side">
            <span class="sup-thread-time">${escapeHtml(fmtTime(t.lastAt))}</span>
            ${t.unread > 0 ? `<span class="sup-unread">${t.unread > 9 ? '9+' : t.unread}</span>` : ''}
          </div>
        </button>`;
    }).join('');
  }

  function renderConvo(messages) {
    const body = $('#sup-convo-body');
    body.innerHTML = (messages || []).map((m) => {
      const who = m.sender === 'admin' ? 'admin' : 'user';
      return `
        <div class="sup-row ${who}">
          <div class="sup-bubble">${escapeHtml(m.body)}</div>
          <div class="sup-time">${escapeHtml(fmtTime(m.createdAt))}</div>
        </div>`;
    }).join('');
    body.scrollTop = body.scrollHeight;
  }

  async function loadThreads() {
    try {
      const data = await RobotrendAuth.api('/api/support/threads');
      threads = data.threads || [];
      renderThreads();
    } catch (e) {
      $('#sup-threads').innerHTML = `<div class="sup-placeholder" style="height:auto; padding:24px; color:var(--danger,#ef4444);">Erro: ${escapeHtml(e.message)}</div>`;
    }
  }

  async function openThread(userId) {
    activeUserId = userId;
    activeThread = threads.find((t) => String(t.userId) === String(userId)) || null;
    renderThreads();

    $('#sup-empty').style.display = 'none';
    $('#sup-convo').style.display = 'flex';
    $('#sup-convo-ava').textContent = activeThread ? initial(activeThread) : '?';
    $('#sup-convo-name').textContent = activeThread ? displayName(activeThread) : '—';
    $('#sup-convo-email').textContent = activeThread?.userEmail || '—';
    $('#sup-convo-body').innerHTML = `<div class="sup-placeholder" style="height:auto;">Carregando…</div>`;

    try {
      const data = await RobotrendAuth.api(`/api/support/threads/${encodeURIComponent(userId)}`);
      renderConvo(data.messages || []);
      // Abrir marca como lido no servidor → zera o badge local e atualiza a lista.
      if (activeThread) activeThread.unread = 0;
      renderThreads();
      $('#sup-reply-text').focus();
    } catch (e) {
      $('#sup-convo-body').innerHTML = `<div class="sup-placeholder" style="height:auto; color:var(--danger,#ef4444);">Erro: ${escapeHtml(e.message)}</div>`;
    }
  }

  $('#sup-threads')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.sup-thread');
    if (!btn) return;
    openThread(btn.dataset.user);
  });

  async function sendReply(e) {
    e.preventDefault();
    const text = $('#sup-reply-text').value.trim();
    if (!text || !activeUserId || sending) return;
    sending = true;
    $('#sup-reply-send').disabled = true;
    try {
      await RobotrendAuth.api(`/api/support/threads/${encodeURIComponent(activeUserId)}/reply`, {
        method: 'POST',
        body: JSON.stringify({ message: text }),
      });
      $('#sup-reply-text').value = '';
      $('#sup-reply-text').style.height = 'auto';
      const data = await RobotrendAuth.api(`/api/support/threads/${encodeURIComponent(activeUserId)}`);
      renderConvo(data.messages || []);
      await loadThreads();
    } catch (err) {
      alert(`Erro ao responder: ${err.message}`);
    } finally {
      sending = false;
      $('#sup-reply-send').disabled = false;
    }
  }

  $('#sup-reply-form')?.addEventListener('submit', sendReply);
  $('#sup-reply-text')?.addEventListener('input', (e) => {
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(120, e.target.scrollHeight) + 'px';
  });
  $('#sup-reply-text')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(e); }
  });

  loadThreads();
  // Atualiza a lista periodicamente para captar novas mensagens.
  setInterval(() => {
    if (document.visibilityState === 'visible') loadThreads();
  }, 30_000);
})();
