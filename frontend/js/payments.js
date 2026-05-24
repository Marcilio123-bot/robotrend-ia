/* ============================================================
   ROBOTREND IA — Payments helper (frontend)
   ------------------------------------------------------------
   Função utilitária `virarPremium()` que:
     1. Garante que o usuário está autenticado (senão → /login.html)
     2. Chama POST /api/payments/create-premium
     3. Redireciona o browser para o init_point do Mercado Pago
     4. Trata fallback mock (dev sem MP_ACCESS_TOKEN)

   IMPORTANTE: o frontend NUNCA libera o premium. Apenas o webhook
   no servidor (que valida o pagamento direto na API do Mercado
   Pago) é capaz de promover o usuário.
   ============================================================ */
(function () {
  'use strict';

  async function virarPremium(opts = {}) {
    const plan = (opts.plan || 'PREMIUM').toUpperCase();
    const coupon = opts.coupon || null;

    if (!window.RobotrendAuth?.getToken?.()) {
      const next = encodeURIComponent(location.pathname + location.search);
      location.href = `/login.html?next=${next}`;
      return;
    }

    // UI feedback (busca botão "carregando" se fornecido)
    const btn = opts.button || null;
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
            'Para liberar o premium em desenvolvimento, abra:\n' + (data.init_point || '/billing/mock-success?plan=PREMIUM&provider=mock')
          );
          if (data.init_point) location.href = data.init_point;
          return;
        }
        throw new Error('Resposta inválida do servidor.');
      }

      // Marca "upgrade pendente" — user-state.js liga polling rápido
      // automaticamente quando a aba reabre / outra aba é aberta.
      try {
        if (window.RobotrendUser?.startUpgradePolling) {
          window.RobotrendUser.startUpgradePolling();
        } else {
          // Fallback: grava direto no localStorage (user-state.js lê no boot)
          localStorage.setItem('robotrend_pending_upgrade', JSON.stringify({
            plan: data.plan || plan,
            startedAt: Date.now(),
          }));
        }
      } catch (_) {}

      // Redireciona para checkout Mercado Pago
      location.href = data.init_point;
    } catch (err) {
      console.error('[virarPremium] erro:', err);
      alert(`Não foi possível gerar o checkout:\n${err.message || err}`);
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = originalLabel;
      }
    }
  }

  window.RobotrendPayments = { virarPremium };
  // Atalho global compatível com o snippet do usuário
  window.virarPremium = virarPremium;
})();
