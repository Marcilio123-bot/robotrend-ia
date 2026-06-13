/* ============================================================
   ROBOTREND IA — Chat de Suporte (Fale Conosco)
   ------------------------------------------------------------
   Botão flutuante + janela de conversa disponível em todas as
   páginas do cliente (FREE e PREMIUM). O usuário envia dúvidas
   e sugestões que ficam armazenadas no sistema; o administrador
   responde posteriormente pelo painel Master (atendimento NÃO
   instantâneo).

   - Não aparece em páginas master/admin (o admin tem área própria).
   - Só inicializa para usuários autenticados (com token).
   - Estilos isolados, injetados via <style> (CSP permite inline).
   ============================================================ */
(function (global) {
  'use strict';

  const WELCOME =
    'Olá! Seja bem-vindo ao suporte Robotrend IA. Envie sua dúvida ou sugestão e responderemos assim que possível.';
  const NOTE =
    'No momento este atendimento não é instantâneo. Deixe sua mensagem e retornaremos o contato assim que possível.';

  const POLL_MS = 30_000;

  let panelOpen = false;
  let pollTimer = null;
  let lastUnread = 0;
  let sending = false;
  const els = {};

  /* ---------- helpers ---------- */
  function isMasterPath() {
    return /^\/(master|admin|ops)(\/|$|\.html?$)/i.test(location.pathname);
  }

  function hasAuth() {
    try { return !!(global.RobotrendAuth && global.RobotrendAuth.getToken()); }
    catch { return false; }
  }

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

  async function api(path, opts) {
    if (global.RobotrendAuth?.api) return global.RobotrendAuth.api(path, opts);
    const res = await fetch(path, { credentials: 'include', ...(opts || {}) });
    return res.json();
  }

  /* ---------- styles ---------- */
  function ensureStyles() {
    if (document.getElementById('rb-support-style')) return;
    const css = `
      .rb-support-fab {
        position: fixed; right: 20px; bottom: 20px; z-index: 9998;
        display: inline-flex; align-items: center; gap: 8px;
        padding: 12px 18px; border: none; cursor: pointer;
        border-radius: 999px; font-family: inherit; font-weight: 800; font-size: 14px;
        color: #04140b; background: linear-gradient(135deg, #14b85e, #0fa653);
        box-shadow: 0 10px 30px rgba(20,184,94,.35), 0 2px 8px rgba(0,0,0,.3);
        transition: transform .15s ease, box-shadow .15s ease, opacity .2s ease;
      }
      .rb-support-fab:hover { transform: translateY(-2px); box-shadow: 0 14px 36px rgba(20,184,94,.45); }
      .rb-support-fab:active { transform: translateY(0); }
      .rb-support-fab-ic { font-size: 18px; line-height: 1; }
      .rb-support-fab-badge {
        position: absolute; top: -4px; right: -4px; min-width: 20px; height: 20px;
        padding: 0 5px; border-radius: 999px; background: #ef4444; color: #fff;
        font-size: 11px; font-weight: 800; display: none; align-items: center; justify-content: center;
        box-shadow: 0 0 0 2px #07100a;
      }
      .rb-support-fab-badge.show { display: inline-flex; }

      .rb-support-panel {
        position: fixed; right: 20px; bottom: 20px; z-index: 9999;
        width: min(380px, calc(100vw - 32px));
        height: min(560px, calc(100vh - 40px));
        display: none; flex-direction: column; overflow: hidden;
        background: var(--surface, #0b1a12);
        border: 1px solid var(--line, rgba(255,255,255,.08));
        border-radius: 18px;
        box-shadow: 0 24px 60px rgba(0,0,0,.55);
        font-family: inherit;
        animation: rb-support-in .18s ease;
      }
      .rb-support-panel.open { display: flex; }
      @keyframes rb-support-in { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }

      .rb-support-head {
        display: flex; align-items: center; gap: 10px; padding: 14px 16px;
        background: linear-gradient(135deg, #14b85e, #0c8a45); color: #04140b;
      }
      .rb-support-head-ava {
        width: 34px; height: 34px; border-radius: 10px; flex: 0 0 auto;
        display: grid; place-items: center; font-weight: 900; font-size: 16px;
        background: rgba(4,20,11,.18); color: #04140b;
      }
      .rb-support-head-meta { flex: 1; min-width: 0; }
      .rb-support-head-title { font-weight: 900; font-size: 15px; line-height: 1.1; }
      .rb-support-head-sub { font-size: 11.5px; font-weight: 700; opacity: .8; }
      .rb-support-x {
        background: rgba(4,20,11,.15); border: none; color: #04140b; cursor: pointer;
        width: 30px; height: 30px; border-radius: 8px; font-size: 18px; line-height: 1;
        display: grid; place-items: center; transition: background .15s ease;
      }
      .rb-support-x:hover { background: rgba(4,20,11,.3); }

      .rb-support-body {
        flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px;
        background:
          radial-gradient(900px 400px at 100% -10%, rgba(20,184,94,.08), transparent 60%),
          var(--surface, #0b1a12);
      }
      .rb-support-row { display: flex; flex-direction: column; max-width: 82%; }
      .rb-support-row.user { align-self: flex-end; align-items: flex-end; }
      .rb-support-row.admin, .rb-support-row.system { align-self: flex-start; align-items: flex-start; }
      .rb-support-bubble {
        padding: 10px 13px; border-radius: 14px; font-size: 13.5px; line-height: 1.5;
        white-space: pre-wrap; word-break: break-word;
      }
      .rb-support-row.user .rb-support-bubble {
        background: linear-gradient(135deg, #14b85e, #0fa653); color: #04140b;
        font-weight: 600; border-bottom-right-radius: 5px;
      }
      .rb-support-row.admin .rb-support-bubble {
        background: var(--surface-2, #11241a); color: var(--text, #e6f4ec);
        border: 1px solid var(--line, rgba(255,255,255,.08)); border-bottom-left-radius: 5px;
      }
      .rb-support-row.system .rb-support-bubble {
        background: rgba(20,184,94,.10); color: var(--text, #e6f4ec);
        border: 1px solid rgba(20,184,94,.30); border-bottom-left-radius: 5px;
      }
      .rb-support-time { font-size: 10.5px; color: var(--muted, #8aa39a); margin-top: 3px; padding: 0 4px; }
      .rb-support-sender { font-size: 10.5px; font-weight: 800; color: #14b85e; margin: 0 4px 3px; letter-spacing: .03em; }

      .rb-support-note {
        font-size: 11.5px; line-height: 1.45; color: var(--muted, #8aa39a);
        padding: 9px 14px; text-align: center;
        border-top: 1px solid var(--line, rgba(255,255,255,.08));
        background: var(--surface, #0b1a12);
      }
      .rb-support-foot {
        display: flex; gap: 8px; padding: 12px; align-items: flex-end;
        border-top: 1px solid var(--line, rgba(255,255,255,.08));
        background: var(--surface, #0b1a12);
      }
      .rb-support-input {
        flex: 1; resize: none; max-height: 110px; min-height: 42px;
        padding: 11px 13px; border-radius: 12px; font-family: inherit; font-size: 13.5px;
        color: var(--text, #e6f4ec); background: var(--surface-2, #11241a);
        border: 1px solid var(--line, rgba(255,255,255,.10)); outline: none;
        transition: border-color .15s ease;
      }
      .rb-support-input:focus { border-color: #14b85e; }
      .rb-support-send {
        flex: 0 0 auto; width: 42px; height: 42px; border-radius: 12px; border: none; cursor: pointer;
        background: linear-gradient(135deg, #14b85e, #0fa653); color: #04140b; font-size: 18px;
        display: grid; place-items: center; transition: transform .12s ease, opacity .15s ease;
      }
      .rb-support-send:hover { transform: translateY(-1px); }
      .rb-support-send:disabled { opacity: .5; cursor: not-allowed; transform: none; }
      .rb-support-empty { color: var(--muted, #8aa39a); font-size: 12.5px; text-align: center; padding: 6px 0; }

      @media (max-width: 480px) {
        .rb-support-panel { right: 8px; bottom: 8px; width: calc(100vw - 16px); height: calc(100vh - 16px); }
        .rb-support-fab { right: 14px; bottom: 14px; }
      }
    `;
    const style = document.createElement('style');
    style.id = 'rb-support-style';
    style.textContent = css;
    document.head.appendChild(style);
  }

  /* ---------- render ---------- */
  function buildUI() {
    ensureStyles();

    const fab = document.createElement('button');
    fab.type = 'button';
    fab.className = 'rb-support-fab';
    fab.id = 'rb-support-fab';
    fab.setAttribute('aria-label', 'Abrir suporte');
    fab.innerHTML = `
      <span class="rb-support-fab-ic" aria-hidden="true">💬</span>
      <span class="rb-support-fab-label">Suporte</span>
      <span class="rb-support-fab-badge" id="rb-support-badge"></span>
    `;

    const panel = document.createElement('div');
    panel.className = 'rb-support-panel';
    panel.id = 'rb-support-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Suporte Robotrend IA');
    panel.innerHTML = `
      <div class="rb-support-head">
        <div class="rb-support-head-ava">R</div>
        <div class="rb-support-head-meta">
          <div class="rb-support-head-title">Suporte Robotrend IA</div>
          <div class="rb-support-head-sub">Fale conosco</div>
        </div>
        <button type="button" class="rb-support-x" id="rb-support-close" aria-label="Fechar">×</button>
      </div>
      <div class="rb-support-body" id="rb-support-body"></div>
      <div class="rb-support-note">${escapeHtml(NOTE)}</div>
      <form class="rb-support-foot" id="rb-support-form">
        <textarea class="rb-support-input" id="rb-support-text" rows="1" maxlength="2000"
          placeholder="Digite sua dúvida ou sugestão…"></textarea>
        <button type="submit" class="rb-support-send" id="rb-support-send" aria-label="Enviar">➤</button>
      </form>
    `;

    document.body.appendChild(fab);
    document.body.appendChild(panel);

    els.fab = fab;
    els.badge = fab.querySelector('#rb-support-badge');
    els.panel = panel;
    els.body = panel.querySelector('#rb-support-body');
    els.form = panel.querySelector('#rb-support-form');
    els.text = panel.querySelector('#rb-support-text');
    els.send = panel.querySelector('#rb-support-send');

    fab.addEventListener('click', toggle);
    panel.querySelector('#rb-support-close').addEventListener('click', close);
    els.form.addEventListener('submit', onSubmit);
    els.text.addEventListener('input', autoGrow);
    els.text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit(e); }
    });
  }

  function autoGrow() {
    els.text.style.height = 'auto';
    els.text.style.height = Math.min(110, els.text.scrollHeight) + 'px';
  }

  function bubbleHtml(m) {
    const sender = m.sender === 'admin' ? 'admin' : 'user';
    const label = sender === 'admin' ? '<div class="rb-support-sender">Suporte</div>' : '';
    return `
      <div class="rb-support-row ${sender}">
        ${label}
        <div class="rb-support-bubble">${escapeHtml(m.body)}</div>
        <div class="rb-support-time">${escapeHtml(fmtTime(m.createdAt))}</div>
      </div>`;
  }

  function renderMessages(messages) {
    const welcome = `
      <div class="rb-support-row system">
        <div class="rb-support-bubble">${escapeHtml(WELCOME)}</div>
      </div>`;
    const list = (messages || []).map(bubbleHtml).join('');
    els.body.innerHTML = welcome + list;
    els.body.scrollTop = els.body.scrollHeight;
  }

  function updateBadge(n) {
    lastUnread = Number(n) || 0;
    if (!els.badge) return;
    if (lastUnread > 0 && !panelOpen) {
      els.badge.textContent = lastUnread > 9 ? '9+' : String(lastUnread);
      els.badge.classList.add('show');
    } else {
      els.badge.classList.remove('show');
    }
  }

  /* ---------- data ---------- */
  async function loadMessages({ markRead = false } = {}) {
    try {
      const data = await api('/api/support/messages');
      renderMessages(data.messages || []);
      if (markRead && Number(data.unread) > 0) {
        api('/api/support/read', { method: 'POST', body: JSON.stringify({}) }).catch(() => {});
        updateBadge(0);
      } else {
        updateBadge(data.unread || 0);
      }
    } catch (e) {
      els.body.innerHTML = `
        <div class="rb-support-row system"><div class="rb-support-bubble">${escapeHtml(WELCOME)}</div></div>
        <div class="rb-support-empty">Não foi possível carregar as mensagens. Tente novamente.</div>`;
    }
  }

  async function pollUnread() {
    if (document.visibilityState === 'hidden') return;
    if (panelOpen) return;
    try {
      const data = await api('/api/support/messages');
      updateBadge(data.unread || 0);
    } catch (_) { /* silencioso */ }
  }

  async function onSubmit(e) {
    e.preventDefault();
    const value = els.text.value.trim();
    if (!value || sending) return;
    sending = true;
    els.send.disabled = true;

    // Eco otimista
    const optimistic = { sender: 'user', body: value, createdAt: new Date().toISOString() };
    els.body.insertAdjacentHTML('beforeend', bubbleHtml(optimistic));
    els.body.scrollTop = els.body.scrollHeight;
    els.text.value = '';
    autoGrow();

    try {
      await api('/api/support/messages', { method: 'POST', body: JSON.stringify({ message: value }) });
      await loadMessages();
    } catch (err) {
      els.body.insertAdjacentHTML('beforeend',
        `<div class="rb-support-empty">Falha ao enviar. Verifique sua conexão e tente novamente.</div>`);
    } finally {
      sending = false;
      els.send.disabled = false;
      els.text.focus();
    }
  }

  /* ---------- open/close ---------- */
  function open() {
    panelOpen = true;
    els.panel.classList.add('open');
    els.fab.style.opacity = '0';
    els.fab.style.pointerEvents = 'none';
    updateBadge(0);
    loadMessages({ markRead: true });
    setTimeout(() => els.text?.focus(), 120);
  }

  function close() {
    panelOpen = false;
    els.panel.classList.remove('open');
    els.fab.style.opacity = '';
    els.fab.style.pointerEvents = '';
    pollUnread();
  }

  function toggle() { panelOpen ? close() : open(); }

  /* ---------- realtime (best-effort) ---------- */
  function attachRealtime() {
    // Resposta do admin chega via socket (emitToUser → 'support:reply').
    // O dashboard mantém o socket; aqui apenas reagimos a um evento global,
    // caso alguma página o reenvie. Sem socket, o polling cobre a atualização.
    window.addEventListener('robotrend:support-reply', () => {
      if (panelOpen) loadMessages({ markRead: true });
      else updateBadge(lastUnread + 1);
    });
  }

  /* ---------- boot ---------- */
  function init() {
    if (isMasterPath()) return;     // admin tem painel próprio
    if (!hasAuth()) return;          // só para usuários logados (FREE/PREMIUM)
    if (document.getElementById('rb-support-fab')) return;

    buildUI();
    attachRealtime();
    pollUnread();
    pollTimer = setInterval(pollUnread, POLL_MS);

    global.RobotrendSupport = {
      open, close, toggle,
      refresh: () => loadMessages({ markRead: panelOpen }),
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
