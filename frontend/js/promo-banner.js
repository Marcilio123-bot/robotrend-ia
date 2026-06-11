/**
 * Robotrend IA — Promo Banner Global
 *
 * Renderiza o banner do Plano Premium mensal (R$ 79,90/mês)
 * em qualquer container com [data-promo-banner] OU como primeiro filho
 * do elemento [data-promo-banner-mount].
 *
 * Visibilidade: TODOS os usuários FREE + visitantes não-logados.
 * Esconde automaticamente para usuários PREMIUM/admin.
 */
(function () {
  'use strict';

  const PRICE_MONTHLY = 79.9;

  function fmtBRL(n) {
    try {
      return Number(n).toLocaleString('pt-BR', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    } catch (_) {
      return Number(n).toFixed(2).replace('.', ',');
    }
  }

  function isPremium() {
    try {
      if (window.RobotrendUser && typeof window.RobotrendUser.isPremium === 'function') {
        return !!window.RobotrendUser.isPremium();
      }
    } catch (_) {}
    return false;
  }

  function buildBannerHTML() {
    return `
      <div class="promo-banner" role="region" aria-label="Plano Premium mensal">
        <span class="promo-banner-badge">💎 Premium</span>
        <div class="promo-banner-main">
          <div class="promo-banner-title">Plano Premium mensal</div>
          <div class="promo-banner-prices">
            <span class="new">Acesso completo por R$ ${fmtBRL(PRICE_MONTHLY)}/mês</span>
          </div>
          <div class="promo-banner-sub">Cobrança mensal · liberação imediata · cancele quando quiser</div>
        </div>
        <button type="button" class="promo-banner-cta" data-promo-cta>
          👉 Assinar por R$ ${fmtBRL(PRICE_MONTHLY)}/mês
        </button>
      </div>
    `;
  }

  function mount() {
    if (isPremium()) {
      document.querySelectorAll('[data-promo-banner-mount]').forEach((el) => {
        el.innerHTML = '';
      });
      document.querySelectorAll('.promo-banner').forEach((el) => el.remove());
      return;
    }

    document.querySelectorAll('[data-promo-banner-mount]').forEach((host) => {
      if (host.querySelector('.promo-banner')) return;
      host.insertAdjacentHTML('afterbegin', buildBannerHTML());
    });

    document.querySelectorAll('[data-promo-cta]').forEach((btn) => {
      if (btn.dataset.promoBound === '1') return;
      btn.dataset.promoBound = '1';
      btn.addEventListener('click', () => {
        if (typeof window.virarPremium === 'function') {
          window.virarPremium({ button: btn });
        } else {
          window.location.href = '/pricing.html';
        }
      });
    });
  }

  function init() {
    mount();
    if (window.RobotrendUser && typeof window.RobotrendUser.onChange === 'function') {
      try { window.RobotrendUser.onChange(() => mount()); } catch (_) {}
    }
    window.addEventListener('robotrend:user-ready', mount);
    window.addEventListener('robotrend:upgrade-detected', mount);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.RobotrendPromo = { mount, PRICE_MONTHLY, fmtBRL };
})();
