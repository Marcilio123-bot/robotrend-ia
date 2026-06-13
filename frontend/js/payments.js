/* ============================================================
   ROBOTREND IA — Payments helper (frontend)
   ------------------------------------------------------------
   `virarPremium()` — abre seletor de plano (Mensal/Semestral/Anual)
   e só então inicia checkout. Use skipPicker:true apenas após o
   usuário já ter escolhido o plano (ex.: fluxo interno da pricing).
   ============================================================ */
(function () {
  'use strict';

  async function checkoutPremium(plan, coupon, btn) {
    let originalLabel = null;
    if (btn) {
      originalLabel = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '⏳ Gerando checkout…';
    }

    try {
      const data = await window.RobotrendAuth.api('/api/payments/create-premium', {
        method: 'POST',
        body: JSON.stringify({ plan, coupon }),
      });

      if (!data?.init_point) {
        if (data?.mock) {
          alert(
            'Pagamentos em modo MOCK (servidor não tem MP_ACCESS_TOKEN configurado).\n\n' +
            'Para liberar o premium em desenvolvimento, abra:\n' + (data.init_point || `/billing/mock-success?plan=${plan}&provider=mock`)
          );
          if (data.init_point) location.href = data.init_point;
          return;
        }
        throw new Error('Resposta inválida do servidor.');
      }

      try {
        if (window.RobotrendUser?.startUpgradePolling) {
          window.RobotrendUser.startUpgradePolling();
        } else {
          localStorage.setItem('robotrend_pending_upgrade', JSON.stringify({
            plan: data.plan || plan,
            startedAt: Date.now(),
          }));
        }
      } catch (_) {}

      location.href = data.init_point;
    } catch (err) {
      console.error('[checkoutPremium] erro:', err);
      alert(`Não foi possível gerar o checkout:\n${err.message || err}`);
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = originalLabel;
      }
    }
  }

  async function virarPremium(opts = {}) {
    const skipPicker = opts.skipPicker === true;
    let plan = opts.plan ? String(opts.plan).toUpperCase() : null;
    const coupon = opts.coupon || null;
    const btn = opts.button || null;

    // VIP legado: checkout direto sem seletor de ciclos Premium.
    if (plan === 'VIP' && skipPicker) {
      if (!window.RobotrendAuth?.getToken?.()) {
        const next = encodeURIComponent(location.pathname + location.search);
        location.href = `/login.html?next=${next}`;
        return;
      }
      return checkoutPremium('VIP', coupon, btn);
    }

    // Sempre mostrar escolha Mensal / Semestral / Anual antes do checkout.
    if (!skipPicker) {
      if (window.RobotrendPlanPicker?.open) {
        const picked = await window.RobotrendPlanPicker.open({ preselected: plan, button: btn });
        if (!picked) return;
        plan = picked;
      } else {
        location.href = '/pricing.html';
        return;
      }
      // Redireciona para pricing com modal de pagamento (cupom, Stripe, PIX).
      if (window.RobotrendPlanPicker?.proceedAfterPlanPick) {
        window.RobotrendPlanPicker.proceedAfterPlanPick(plan);
        return;
      }
    }

    if (!window.RobotrendAuth?.getToken?.()) {
      const next = encodeURIComponent(`/pricing.html?checkout=${plan || 'PREMIUM'}`);
      location.href = `/login.html?next=${next}`;
      return;
    }

    return checkoutPremium(plan || 'PREMIUM', coupon, btn);
  }

  window.RobotrendPayments = { virarPremium, checkoutPremium };
  window.virarPremium = virarPremium;
})();
