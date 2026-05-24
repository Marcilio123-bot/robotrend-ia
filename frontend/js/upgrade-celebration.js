/* ============================================================
   ROBOTREND IA — Upgrade Celebration
   ------------------------------------------------------------
   Reage ao evento global 'robotrend:upgrade-detected' (disparado
   pelo user-state.js quando o servidor confirma isPremium=true).

   Garante experiência PREMIUM instantânea EM QUALQUER PÁGINA:

     1. Socket também emite 'user:upgraded' → fallback se outra
        página não tiver listener próprio.
     2. Toast verde celebratório (canto inferior direito).
     3. Modal "Bem-vindo ao Premium" no centro (1ª vez).
     4. Sound chime celebratório (se permitido).
     5. Confetti CSS rápido.
     6. Re-render do sidebar (some o CTA "Virar Premium").

   ÚNICO por session — usa sessionStorage flag para não mostrar
   o modal grande em todas as abas/refresh.
   ============================================================ */
(function () {
  'use strict';

  const SESSION_FLAG = 'robotrend_upgrade_celebrated';

  let triggered = false;

  function alreadyCelebrated() {
    try { return sessionStorage.getItem(SESSION_FLAG) === '1'; }
    catch (_) { return false; }
  }
  function markCelebrated() {
    try { sessionStorage.setItem(SESSION_FLAG, '1'); } catch (_) {}
  }

  function ensureToastStack() {
    let stack = document.getElementById('toast-stack');
    if (stack) return stack;
    stack = document.createElement('div');
    stack.id = 'toast-stack';
    stack.style.cssText = `
      position: fixed; bottom: 20px; right: 20px; z-index: 9999;
      display: flex; flex-direction: column; gap: 10px; pointer-events: none;
    `;
    document.body.appendChild(stack);
    return stack;
  }

  function showToast(plan) {
    const stack = ensureToastStack();
    const el = document.createElement('div');
    el.className = 'toast success';
    el.style.cssText = `
      pointer-events: auto;
      min-width: 320px;
      padding: 14px 18px;
      border-radius: 14px;
      background: linear-gradient(135deg, rgba(20,184,94,.22), rgba(0,217,126,.08));
      border: 1px solid rgba(20,184,94,.55);
      box-shadow: 0 0 32px rgba(20,184,94,.45), 0 8px 24px rgba(0,0,0,.4);
      color: #e6f5ec;
      font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
      animation: rrToastIn .4s cubic-bezier(.2,1,.3,1);
    `;
    el.innerHTML = `
      <div style="font-weight:900; font-size:15px; color:#14b85e; margin-bottom:4px;">
        🎉 Você agora é PREMIUM!
      </div>
      <div style="font-size:13px; line-height:1.45; color:#cfe6d8;">
        Plano <b>${escapeHtml(plan || 'PREMIUM')}</b> ativo · Recursos liberados.
      </div>
    `;
    stack.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateX(20px)';
      el.style.transition = 'all .4s ease';
      setTimeout(() => el.remove(), 400);
    }, 7000);
  }

  function showModal(plan, planLabel) {
    if (alreadyCelebrated()) return;
    markCelebrated();

    const overlay = document.createElement('div');
    overlay.className = 'rr-upgrade-overlay';
    overlay.innerHTML = `
      <div class="rr-upgrade-modal">
        <div class="rr-upgrade-confetti">
          ${Array.from({ length: 30 }, (_, i) => `<span style="--i:${i}"></span>`).join('')}
        </div>
        <div class="rr-upgrade-icon">💎</div>
        <h2 class="rr-upgrade-title">Bem-vindo ao ${escapeHtml(planLabel || 'Premium')}!</h2>
        <p class="rr-upgrade-sub">Seu pagamento foi aprovado e seu plano está ativo.</p>
        <div class="rr-upgrade-perks">
          <div class="rr-upgrade-perk"><span>⚡</span> Sinais em tempo real, sem delay</div>
          <div class="rr-upgrade-perk"><span>🎯</span> Filtro de qualidade ≥ 75%</div>
          <div class="rr-upgrade-perk"><span>💎</span> Melhor Aposta do Momento</div>
          <div class="rr-upgrade-perk"><span>🧠</span> Análise IA completa</div>
        </div>
        <button type="button" class="rr-upgrade-cta">Começar a usar agora →</button>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = () => {
      overlay.style.opacity = '0';
      setTimeout(() => overlay.remove(), 300);
    };
    overlay.querySelector('.rr-upgrade-cta').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    // Auto-close em 20s
    setTimeout(() => { if (document.body.contains(overlay)) close(); }, 20000);
  }

  function playChime() {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      const ctx = new AudioContext();
      const now = ctx.currentTime;
      // Acorde alegre: C5 → E5 → G5
      [523.25, 659.25, 783.99].forEach((f, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain).connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.value = f;
        gain.gain.setValueAtTime(0, now + i * 0.12);
        gain.gain.linearRampToValueAtTime(0.18, now + i * 0.12 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.12 + 0.55);
        osc.start(now + i * 0.12);
        osc.stop(now + i * 0.12 + 0.6);
      });
      setTimeout(() => { try { ctx.close(); } catch (_) {} }, 1200);
    } catch (_) {}
  }

  function tryBrowserNotify(plan) {
    try {
      if (!('Notification' in window)) return;
      if (Notification.permission !== 'granted') return;
      new Notification('Plano Premium ativado!', {
        body: `Robotrend IA — plano ${plan || 'PREMIUM'} liberado.`,
        icon: '/icons/icon-192.png',
        tag: 'rr-upgrade',
      });
    } catch (_) {}
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]);
  }

  function celebrate(detail) {
    if (triggered) return;        // 1x por evento
    triggered = true;
    setTimeout(() => { triggered = false; }, 5000);

    const plan = detail?.plan || 'PREMIUM';
    const planLabel = detail?.planLabel || (plan === 'VIP' ? 'VIP' : 'Premium');

    showToast(plan);
    showModal(plan, planLabel);
    playChime();
    tryBrowserNotify(plan);

    console.info('[upgrade-celebration] 🎉 user upgraded to', plan);
  }

  // ============ Listeners ============

  // 1) Fonte principal: user-state.js detectou mudança real
  window.addEventListener('robotrend:upgrade-detected', (ev) => {
    celebrate(ev.detail);
  });

  // 2) Fallback: alguma página emitiu o evento legado do socket
  window.addEventListener('robotrend:user-upgraded-event', (ev) => {
    celebrate(ev.detail);
  });

  // 3) Conecta diretamente no socket global se disponível (em páginas que
  //    têm /socket.io carregado). Garante que mesmo páginas sem dashboard.js
  //    (ex: analytics, signals, account) recebam o evento.
  function attachSocket() {
    if (typeof window.io !== 'function') return;
    try {
      const sock = window.__rrCelebrationSocket || window.io({
        transports: ['websocket', 'polling'],
        auth: { token: window.RobotrendAuth?.getToken?.() || '' },
        reconnection: true,
      });
      window.__rrCelebrationSocket = sock;
      sock.on('user:upgraded', async (payload) => {
        console.info('[upgrade-celebration] socket user:upgraded', payload);
        // Sempre força refresh — user-state.onChange dispara o resto
        try { await window.RobotrendUser?.refresh?.({ force: true }); } catch (_) {}
        // Se RobotrendUser não estiver disponível, celebra direto
        if (!window.RobotrendUser) celebrate(payload);
      });
    } catch (err) {
      console.warn('[upgrade-celebration] socket attach falhou', err);
    }
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    attachSocket();
  } else {
    document.addEventListener('DOMContentLoaded', attachSocket);
  }

  // Expõe API pública para testes
  window.RobotrendCelebration = { trigger: celebrate, _reset: () => { triggered = false; try { sessionStorage.removeItem(SESSION_FLAG); } catch (_) {} } };
})();
