/* ============================================================
   ROBOTREND IA — Toast Notifications
   ------------------------------------------------------------
   Sistema global de notificações. Substitui pushToast() local
   e alerts soltos. API:

     RobotrendToast.success(title, body, opts?)
     RobotrendToast.error(title, body, opts?)
     RobotrendToast.warning(title, body, opts?)
     RobotrendToast.info(title, body, opts?)
     RobotrendToast.show({ kind, title, body, ttl, sticky })

   Opts:
     ttl     — ms até auto-dismiss (default 6500)
     sticky  — não fecha sozinho (default false)
     action  — { label, onClick } botão extra

   Mounta sozinho em #robotrend-toast-stack (cria se não existir).
   Coexiste com a stack legada #toast-stack — espelha lá também.
   ============================================================ */
(function () {
  'use strict';

  if (window.RobotrendToast) return;

  const KINDS = new Set(['success', 'error', 'warning', 'info']);
  let stack = null;

  function ensureStack() {
    if (stack && document.body.contains(stack)) return stack;
    stack = document.getElementById('robotrend-toast-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'robotrend-toast-stack';
      stack.className = 'rt-toast-stack';
      document.body.appendChild(stack);
    }
    return stack;
  }

  function esc(s) {
    return window.RobotrendSanitize?.escapeHtml(s) ?? String(s ?? '');
  }

  function show(opts = {}) {
    const kind = KINDS.has(opts.kind) ? opts.kind : 'info';
    const ttl  = Number.isFinite(opts.ttl) ? opts.ttl : 6500;
    const root = ensureStack();
    const el = document.createElement('div');
    el.className = `rt-toast rt-toast-${kind}`;
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');

    const titleHtml = opts.title ? `<div class="rt-toast-title">${esc(opts.title)}</div>` : '';
    const bodyHtml  = opts.body  ? `<div class="rt-toast-body">${esc(opts.body)}</div>`   : '';
    const actHtml   = opts.action?.label
      ? `<button class="rt-toast-action" type="button">${esc(opts.action.label)}</button>`
      : '';

    el.innerHTML = `
      <span class="rt-toast-icon" aria-hidden="true">${iconFor(kind)}</span>
      <div class="rt-toast-text">${titleHtml}${bodyHtml}</div>
      <div class="rt-toast-actions">
        ${actHtml}
        <button class="rt-toast-close" type="button" aria-label="Fechar">×</button>
      </div>
    `;

    root.appendChild(el);
    requestAnimationFrame(() => el.classList.add('rt-toast-in'));

    const close = () => {
      el.classList.remove('rt-toast-in');
      el.classList.add('rt-toast-out');
      setTimeout(() => el.remove(), 280);
    };

    el.querySelector('.rt-toast-close')?.addEventListener('click', close);
    if (opts.action?.onClick) {
      el.querySelector('.rt-toast-action')?.addEventListener('click', () => {
        try { opts.action.onClick(); } catch (e) { console.warn(e); }
        close();
      });
    }

    if (!opts.sticky && ttl > 0) {
      setTimeout(close, ttl);
    }

    // Bus para observability
    try { window.RobotrendBus?.emit('robotrend:toast', { kind, title: opts.title, body: opts.body }); } catch (_) {}

    return { close, el };
  }

  function iconFor(kind) {
    return ({ success: '✓', error: '✕', warning: '!', info: 'i' }[kind] || 'i');
  }

  const api = {
    show,
    success: (title, body, opts) => show({ ...opts, kind: 'success', title, body }),
    error:   (title, body, opts) => show({ ...opts, kind: 'error',   title, body }),
    warning: (title, body, opts) => show({ ...opts, kind: 'warning', title, body }),
    info:    (title, body, opts) => show({ ...opts, kind: 'info',    title, body }),
  };

  window.RobotrendToast = api;
})();
