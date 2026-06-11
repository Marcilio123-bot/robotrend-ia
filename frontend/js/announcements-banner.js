/* ============================================================
   ROBOTREND IA — Banner de Avisos (cliente)
   ------------------------------------------------------------
   Busca os comunicados ATIVOS em /api/announcements e exibe um
   banner no topo do conteúdo para todos os usuários ao entrar.
   Cada aviso pode ser dispensado (lembrado por id+updatedAt no
   localStorage); editar o aviso faz ele reaparecer.
   ============================================================ */
(function (global) {
  'use strict';

  const DISMISS_KEY = 'robotrend_dismissed_announcements_v1';

  // Não exibe nas telas administrativas (master/admin/ops) — só na visão cliente.
  function isMasterPath() {
    return /^\/(master|admin|ops)(\/|$|\.html?$)/i.test(location.pathname);
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function getDismissed() {
    try { return JSON.parse(localStorage.getItem(DISMISS_KEY) || '{}'); }
    catch { return {}; }
  }
  function setDismissed(map) {
    try { localStorage.setItem(DISMISS_KEY, JSON.stringify(map)); } catch (_) {}
  }
  /** Chave única por versão do aviso — edição (updatedAt novo) reativa. */
  function sig(a) { return `${a.id}:${a.updatedAt || a.createdAt || ''}`; }

  function ensureStyles() {
    if (document.getElementById('rb-announce-style')) return;
    const css = `
      .rb-announce-stack { display:flex; flex-direction:column; gap:10px; margin-bottom:16px; }
      .rb-announce {
        display:flex; align-items:flex-start; gap:12px;
        border:1px solid var(--brand,#14b85e); border-left-width:4px;
        background:var(--brand-soft,rgba(20,184,94,.10));
        border-radius:12px; padding:14px 16px;
      }
      .rb-announce-ic { font-size:18px; line-height:1.2; }
      .rb-announce-body { flex:1; min-width:0; }
      .rb-announce-title { font-weight:800; font-size:14px; color:var(--text,#e6f4ec); margin-bottom:2px; }
      .rb-announce-msg { font-size:13px; line-height:1.5; color:var(--text-2,#b9cabf); white-space:pre-wrap; }
      .rb-announce-x {
        background:transparent; border:none; color:var(--muted,#8aa);
        font-size:18px; cursor:pointer; padding:0 4px; line-height:1;
      }
      .rb-announce-x:hover { color:var(--text,#e6f4ec); }
    `;
    const style = document.createElement('style');
    style.id = 'rb-announce-style';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function mountPoint() {
    const main = document.querySelector('main.saas-content') || document.querySelector('.saas-content');
    if (!main) return null;
    let stack = document.getElementById('rb-announce-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'rb-announce-stack';
      stack.className = 'rb-announce-stack';
      // Insere logo após o header da página (se houver), senão no topo do main.
      const header = main.querySelector('.saas-page-header');
      if (header && header.nextSibling) {
        main.insertBefore(stack, header.nextSibling);
      } else if (header) {
        main.appendChild(stack);
      } else {
        main.insertBefore(stack, main.firstChild);
      }
    }
    return stack;
  }

  function render(announcements) {
    const visible = announcements.filter((a) => a.active);
    if (!visible.length) return;
    const dismissed = getDismissed();
    const pending = visible.filter((a) => !dismissed[sig(a)]);
    if (!pending.length) return;

    ensureStyles();
    const stack = mountPoint();
    if (!stack) return;

    stack.innerHTML = pending.map((a) => `
      <div class="rb-announce" data-sig="${escapeHtml(sig(a))}">
        <span class="rb-announce-ic" aria-hidden="true">📢</span>
        <div class="rb-announce-body">
          <div class="rb-announce-title">${escapeHtml(a.title)}</div>
          <div class="rb-announce-msg">${escapeHtml(a.message)}</div>
        </div>
        <button class="rb-announce-x" title="Dispensar" aria-label="Dispensar aviso">×</button>
      </div>
    `).join('');

    stack.querySelectorAll('.rb-announce-x').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const card = e.target.closest('.rb-announce');
        if (!card) return;
        const map = getDismissed();
        map[card.dataset.sig] = Date.now();
        setDismissed(map);
        card.remove();
      });
    });
  }

  async function load() {
    if (isMasterPath()) return;
    try {
      const r = await fetch('/api/announcements', { credentials: 'include' });
      if (!r.ok) return;
      const data = await r.json();
      render(data.announcements || []);
    } catch (_) { /* avisos nunca quebram a página */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load);
  } else {
    load();
  }
})(window);
