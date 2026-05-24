/**
 * Robotrend IA — Promo Banner Global
 *
 * Renderiza o banner promocional fixo "De R$ 499,99 por R$ 199,99"
 * em qualquer container com [data-promo-banner] OU como primeiro filho
 * do elemento [data-promo-banner-mount].
 *
 * Visibilidade: TODOS os usuários FREE + visitantes não-logados.
 * Esconde automaticamente para usuários PREMIUM/admin.
 */
(function () {
  'use strict';

  const PRICE_PROMO = 199.99;
  const PRICE_FULL  = 499.99;

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
      <div class="promo-banner" role="region" aria-label="Promoção Premium">
        <span class="promo-banner-badge">💥 Oferta</span>
        <div class="promo-banner-main">
          <div class="promo-banner-title">PROMOÇÃO LIMITADA · Plano Premium</div>
          <div class="promo-banner-prices">
            <span class="old">R$ ${fmtBRL(PRICE_FULL)}</span>
            <span class="new">por apenas R$ ${fmtBRL(PRICE_PROMO)}</span>
          </div>
          <div class="promo-banner-sub">Acesso completo — PIX ou cartão · liberação imediata</div>
        </div>
        <button type="button" class="promo-banner-cta" data-promo-cta>
          👉 Garantir por R$ ${fmtBRL(PRICE_PROMO)}
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

  window.RobotrendPromo = { mount, PRICE_PROMO, PRICE_FULL, fmtBRL };
})();
