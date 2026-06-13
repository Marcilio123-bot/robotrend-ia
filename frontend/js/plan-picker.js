/* Robotrend IA — Seletor global de planos Premium (Mensal / Semestral / Anual)
   Usado por virarPremium() e pelos CTAs de upgrade em todo o app. */
(function () {
  'use strict';

  const PREMIUM_PLANS = new Set(['PREMIUM', 'SEMESTRAL', 'ANUAL']);
  let cyclesCache = null;
  let loadPromise = null;

  function fmtBRL(n) {
    return Number(n || 0).toFixed(2).replace('.', ',');
  }

  function monthlyEquivalent(c) {
    const months = (c.durationDays || 30) / 30;
    return c.priceBRL / months;
  }

  function savingsPct(c, monthly) {
    if (!monthly || c.id === 'PREMIUM') return 0;
    const eq = monthlyEquivalent(c);
    return Math.max(0, Math.round((1 - eq / monthly.priceBRL) * 100));
  }

  function cycleMeta(c) {
    if (c.id === 'PREMIUM') {
      return { short: 'Mensal', sub: 'Renovação mensal', badge: null };
    }
    if (c.id === 'SEMESTRAL') {
      return { short: 'Semestral', sub: '180 dias de acesso', badge: '6 meses' };
    }
    if (c.id === 'ANUAL') {
      return { short: 'Anual', sub: '365 dias de acesso', badge: 'Melhor valor' };
    }
    return { short: c.label || c.id, sub: '', badge: null };
  }

  async function fetchCycles() {
    if (cyclesCache) return cyclesCache;
    if (!loadPromise) {
      loadPromise = fetch('/api/plans/cycles')
        .then((r) => r.json())
        .then((d) => {
          cyclesCache = d.cycles || [];
          return cyclesCache;
        })
        .catch(() => []);
    }
    return loadPromise;
  }

  function ensureStyles() {
    if (document.getElementById('rb-plan-picker-styles')) return;
    const s = document.createElement('style');
    s.id = 'rb-plan-picker-styles';
    s.textContent = `
      .rb-pp-backdrop { position:fixed; inset:0; z-index:9998; background:rgba(3,8,5,.88); backdrop-filter:blur(8px);
        display:grid; place-items:center; padding:16px; animation:rbPpFade .2s ease; }
      @keyframes rbPpFade { from{opacity:0} to{opacity:1} }
      .rb-pp-panel { width:100%; max-width:720px; background:var(--card-bg,#0f1f16); border:1px solid var(--line,#1d3328);
        border-radius:20px; padding:24px; box-shadow:0 24px 64px rgba(0,0,0,.45); max-height:92vh; overflow-y:auto; }
      .rb-pp-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:18px; }
      .rb-pp-title { font-size:20px; font-weight:900; }
      .rb-pp-sub { font-size:13px; color:var(--muted,#7c9486); margin-top:4px; }
      .rb-pp-close { border:none; background:var(--surface-2,#11241a); color:var(--text,#e6f4ec); width:36px; height:36px;
        border-radius:10px; cursor:pointer; font-size:18px; border:1px solid var(--line); flex-shrink:0; }
      .rb-pp-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:12px; }
      .rb-pp-card { text-align:left; border:1px solid var(--line); border-radius:16px; padding:18px 16px; cursor:pointer;
        background:var(--surface-2,#11241a); transition:border-color .15s, transform .15s, box-shadow .15s; position:relative; }
      .rb-pp-card:hover { border-color:var(--brand,#14b85e); transform:translateY(-2px); }
      .rb-pp-card.featured { border-color:var(--brand,#14b85e); box-shadow:0 0 24px rgba(20,184,94,.18); }
      .rb-pp-card.selected { border-color:var(--brand,#14b85e); background:rgba(20,184,94,.08); }
      .rb-pp-badge { position:absolute; top:10px; right:10px; font-size:10px; font-weight:800; padding:3px 8px;
        border-radius:999px; background:rgba(20,184,94,.18); color:var(--brand,#14b85e); }
      .rb-pp-save { font-size:11px; font-weight:800; color:#ffb547; margin-top:6px; }
      .rb-pp-name { font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); }
      .rb-pp-price { font-size:26px; font-weight:900; margin-top:6px; }
      .rb-pp-cycle { font-size:12px; color:var(--muted); margin-top:2px; }
      .rb-pp-foot { margin-top:16px; font-size:12px; color:var(--muted); text-align:center; }
    `;
    document.head.appendChild(s);
  }

  function cardHtml(c, monthly, preselected) {
    const meta = cycleMeta(c);
    const pct = savingsPct(c, monthly);
    const featured = c.id === 'ANUAL';
    const selected = c.id === preselected;
    return `
      <button type="button" class="rb-pp-card${featured ? ' featured' : ''}${selected ? ' selected' : ''}" data-plan="${c.id}">
        ${meta.badge ? `<span class="rb-pp-badge">${meta.badge}</span>` : ''}
        <div class="rb-pp-name">Premium ${meta.short}</div>
        <div class="rb-pp-price">R$ ${fmtBRL(c.priceBRL)}</div>
        <div class="rb-pp-cycle">${meta.sub}</div>
        ${pct > 0 ? `<div class="rb-pp-save">Economize ${pct}% vs. mensal</div>` : ''}
      </button>`;
  }

  /**
   * Abre o seletor de plano. Retorna Promise<string|null> com o id do plano escolhido.
   * @param {{ preselected?: string, button?: HTMLElement }} opts
   */
  function openPlanPicker(opts = {}) {
    return new Promise(async (resolve) => {
      ensureStyles();
      const cycles = await fetchCycles();
      if (!cycles.length) {
        resolve(opts.preselected || 'PREMIUM');
        return;
      }

      const monthly = cycles.find((c) => c.id === 'PREMIUM');
      const preselected = opts.preselected && PREMIUM_PLANS.has(String(opts.preselected).toUpperCase())
        ? String(opts.preselected).toUpperCase()
        : null;

      const backdrop = document.createElement('div');
      backdrop.className = 'rb-pp-backdrop';
      backdrop.setAttribute('role', 'dialog');
      backdrop.setAttribute('aria-modal', 'true');
      backdrop.innerHTML = `
        <div class="rb-pp-panel">
          <div class="rb-pp-head">
            <div>
              <div class="rb-pp-title">Escolha seu plano Premium</div>
              <div class="rb-pp-sub">Planos a partir de R$ ${fmtBRL(monthly?.priceBRL || 79.9)} · mesmo acesso completo</div>
            </div>
            <button type="button" class="rb-pp-close" aria-label="Fechar">✕</button>
          </div>
          <div class="rb-pp-grid">
            ${cycles.map((c) => cardHtml(c, monthly, preselected)).join('')}
          </div>
          <div class="rb-pp-foot">Todos os planos liberam o acesso Premium completo imediatamente após o pagamento.</div>
        </div>`;

      function close(result) {
        backdrop.remove();
        document.removeEventListener('keydown', onKey);
        resolve(result);
      }

      function onKey(e) {
        if (e.key === 'Escape') close(null);
      }

      backdrop.querySelector('.rb-pp-close')?.addEventListener('click', () => close(null));
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) close(null);
      });
      backdrop.querySelectorAll('[data-plan]').forEach((btn) => {
        btn.addEventListener('click', () => close(btn.getAttribute('data-plan')));
      });

      document.addEventListener('keydown', onKey);
      document.body.appendChild(backdrop);
    });
  }

  /** Após escolher plano: login ou checkout na página de preços. */
  function proceedAfterPlanPick(planId) {
    const plan = String(planId || 'PREMIUM').toUpperCase();
    const checkoutUrl = `/pricing.html?checkout=${encodeURIComponent(plan)}`;
    if (!window.RobotrendAuth?.getToken?.()) {
      location.href = `/login.html?next=${encodeURIComponent(checkoutUrl)}`;
      return;
    }
    if (location.pathname.endsWith('pricing.html')) {
      window.RobotrendPricing?.openCheckout?.(plan);
      return;
    }
    location.href = checkoutUrl;
  }

  window.RobotrendPlanPicker = {
    open: openPlanPicker,
    fetchCycles,
    fmtBRL,
    savingsPct,
    monthlyEquivalent,
    cycleMeta,
    proceedAfterPlanPick,
    PREMIUM_PLANS,
    PRICE_FROM: 79.9,
  };
})();
