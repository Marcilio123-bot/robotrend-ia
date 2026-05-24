/**
 * Robotrend IA — Mercado Pago Service
 * ---------------------------------------------------------------
 * Service dedicado para Mercado Pago. Encapsula:
 *   - configuração do client (MP_ACCESS_TOKEN)
 *   - factory de Preference (criação de checkout)
 *   - factory de Payment (consulta de status para o webhook)
 *
 * Em dev (sem MP_ACCESS_TOKEN), expõe `enabled: false` e os métodos
 * lançam erro claro — o caller fallback para mock.
 *
 * USO (no payments.js):
 *   const mp = require('./services/mercadopago');
 *   if (mp.enabled) {
 *     const pref = mp.preference();
 *     const created = await pref.create({ body: {...} });
 *     ...
 *     const pay = mp.payment();
 *     const info = await pay.get({ id: paymentId });
 *   }
 */

'use strict';

const { logger } = require('../logger');
const log = logger.child({ module: 'mercadopago' });

let MercadoPagoConfig = null;
let PreferenceCls = null;
let PaymentCls = null;
let MerchantOrderCls = null;
try {
  ({ MercadoPagoConfig, Preference: PreferenceCls, Payment: PaymentCls, MerchantOrder: MerchantOrderCls } = require('mercadopago'));
} catch (err) {
  log.warn('SDK mercadopago não disponível — instale com `npm install mercadopago` para habilitar pagamentos reais', { err: err.message });
}

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const PUBLIC_KEY   = process.env.MP_PUBLIC_KEY || '';
const ENABLED = Boolean(ACCESS_TOKEN) && Boolean(MercadoPagoConfig);

let config = null;
if (ENABLED) {
  config = new MercadoPagoConfig({
    accessToken: ACCESS_TOKEN,
    options: {
      timeout: 10000,
      // idempotencyKey é setado por request quando relevante
    },
  });
  const isTest = ACCESS_TOKEN.startsWith('TEST-');
  log.info('Mercado Pago SDK inicializado', {
    mode: isTest ? 'TEST' : 'PRODUCTION',
    publicKey: PUBLIC_KEY ? PUBLIC_KEY.slice(0, 20) + '…' : 'missing',
  });
} else if (!MercadoPagoConfig) {
  // SDK não instalado
} else {
  log.warn('Mercado Pago desativado — MP_ACCESS_TOKEN ausente. Sistema operará em modo MOCK.');
}

function assertEnabled() {
  if (!ENABLED) {
    const reason = !MercadoPagoConfig
      ? 'SDK mercadopago não instalado'
      : 'MP_ACCESS_TOKEN ausente no .env';
    throw new Error(`Mercado Pago indisponível: ${reason}`);
  }
}

function preference() {
  assertEnabled();
  return new PreferenceCls(config);
}

function payment() {
  assertEnabled();
  return new PaymentCls(config);
}

function merchantOrder() {
  assertEnabled();
  return new MerchantOrderCls(config);
}

module.exports = {
  enabled: ENABLED,
  publicKey: PUBLIC_KEY,
  preference,
  payment,
  merchantOrder,
};
