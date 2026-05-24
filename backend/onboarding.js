/**
 * Robotrend IA — Onboarding / Trial / Email
 *
 *   - Trial 7 dias Premium ao se cadastrar
 *   - Welcome email (mock console em dev / SMTP em prod via variáveis)
 *   - Funil de conversão (eventos: signup, first_signal, upgrade_intent, paid)
 *   - Email pluggable: implemente sendEmail() para integrar Resend/SendGrid/SMTP
 */

'use strict';

const { logger } = require('./logger');

const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 7);

/**
 * Aplicar trial automático ao registrar.
 */
async function applyTrial(db, user) {
  const expiresAt = new Date(Date.now() + TRIAL_DAYS * 24 * 3600 * 1000);
  await db.upsertSubscription(user.id, {
    plan: 'PREMIUM', // trial dá Premium temporariamente
    provider: 'trial',
    externalId: 'trial-' + user.id,
    status: 'trialing',
    expiresAt,
  });
  logger.info('trial aplicado', { userId: user.id, days: TRIAL_DAYS });
  return expiresAt;
}

/**
 * Envia email (placeholder universal).
 * Em produção, configure as variáveis SMTP_* ou use Resend/SendGrid.
 */
async function sendEmail({ to, subject, text, html }) {
  // Hook pluggable — substitua o corpo daqui pelo provedor real
  if (process.env.RESEND_API_KEY) {
    // Resend (https://resend.com) — exemplo simples sem dep
    try {
      const fetch = global.fetch || require('node-fetch');
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: process.env.EMAIL_FROM || 'Robotrend IA <no-reply@robotrend.local>',
          to: [to], subject, text, html,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      return { ok: true, provider: 'resend' };
    } catch (e) {
      logger.error('resend email falhou', { err: e.message });
      return { ok: false, error: e.message };
    }
  }
  // Mock dev
  logger.info('[email MOCK] (configure RESEND_API_KEY ou SMTP_* p/ envio real)', {
    to, subject,
  });
  console.log('\n──────────── EMAIL MOCK ────────────');
  console.log('To:', to);
  console.log('Subject:', subject);
  console.log(text);
  console.log('────────────────────────────────────\n');
  return { ok: true, mocked: true };
}

/**
 * welcomeEmail — boas-vindas ao novo cliente.
 *   - Se vier com `initialPassword` (cliente criado via webhook de pagamento),
 *     envia também as credenciais iniciais para que ele consiga logar.
 *   - Se vier sem senha (auto-cadastro), apenas dá boas-vindas + trial.
 */
function welcomeEmail(user) {
  const link = (process.env.PUBLIC_URL || 'http://localhost:3010');
  const hasInitialPassword = Boolean(user.initialPassword);
  const planLabel = user.plan ? String(user.plan).toUpperCase() : 'PREMIUM';

  const credentialsBlockText = hasInitialPassword
    ? `\n🔐 Suas credenciais de acesso:\n   E-mail: ${user.email}\n   Senha:  ${user.initialPassword}\n\n⚠️ Troque sua senha após o primeiro acesso em /perfil.\n`
    : '';

  const credentialsBlockHtml = hasInitialPassword
    ? `<div style="background:#0e1a14;border:1px solid #14b85e;border-radius:10px;padding:14px 18px;margin:14px 0;color:#e6f5ec;font-family:'JetBrains Mono',monospace;font-size:13px">
        <div style="color:#7c9486;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Suas credenciais</div>
        <div><b>E-mail:</b> ${user.email}</div>
        <div><b>Senha:</b> ${user.initialPassword}</div>
        <div style="color:#ffb547;margin-top:8px;font-size:11px">⚠ Troque sua senha após o primeiro acesso.</div>
      </div>`
    : '';

  const subject = hasInitialPassword
    ? `✅ Pagamento confirmado — sua conta Robotrend IA (${planLabel}) está ativa`
    : '🤖 Bem-vindo ao Robotrend IA — seu trial Premium de 7 dias está ativo';

  const intro = hasInitialPassword
    ? `Pagamento confirmado! Sua conta ${planLabel} está ativa.`
    : `Sua conta foi criada e você ganhou um trial Premium de ${TRIAL_DAYS} dias.`;

  return sendEmail({
    to: user.email,
    subject,
    text:
`Olá ${user.name || ''}!

${intro}
${credentialsBlockText}
Acesse: ${link}/login.html

${hasInitialPassword
  ? 'Sua assinatura está ativa por 30 dias e renovará automaticamente.'
  : `Quando o trial expirar, sua conta volta automaticamente para Free.\nAssine para continuar: ${link}/pricing.html`}

— Robotrend IA`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#07100a;padding:24px;border-radius:12px;color:#e6f5ec">
      <h2 style="color:#14b85e;margin-top:0">${hasInitialPassword ? '✅ Pagamento confirmado' : '🤖 Bem-vindo ao Robotrend IA'}</h2>
      <p>Olá <b>${user.name || ''}</b>!</p>
      <p>${intro}</p>
      ${credentialsBlockHtml}
      <p><a href="${link}/login.html" style="display:inline-block;background:#14b85e;color:#03110b;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">Acessar painel →</a></p>
      <p style="color:#7c9486;font-size:12px;margin-top:20px">${hasInitialPassword
        ? 'Sua assinatura está ativa por 30 dias e renovará automaticamente.'
        : `Quando o trial expirar, sua conta volta para Free. Assine em ${link}/pricing.html para continuar.`}</p>
    </div>`,
  });
}

function paymentReceivedEmail(user, payment) {
  return sendEmail({
    to: user.email,
    subject: `✅ Pagamento recebido — plano ${payment.plan}`,
    text:
`Olá ${user.name || ''}!

Recebemos seu pagamento de R$ ${Number(payment.amount).toFixed(2)} (${payment.plan}).
Sua conta foi atualizada com sucesso.

— Robotrend IA`,
  });
}

/* ============================================================
   FUNIL — eventos de conversão (in-memory rolling)
   ============================================================ */
const funnel = {
  signup: 0,
  first_signal_seen: 0,
  upgrade_intent: 0,
  paid: 0,
  events: [], // últimas 200
};

function track(event, ctx = {}) {
  const evt = { event, ctx, ts: new Date().toISOString() };
  if (funnel[event] !== undefined) funnel[event]++;
  funnel.events.push(evt);
  if (funnel.events.length > 200) funnel.events.shift();
  logger.debug('funnel', { event, ...ctx });
}

function funnelSnapshot() {
  const conversion = funnel.signup ? Math.round((funnel.paid / funnel.signup) * 100) : 0;
  return {
    counts: { signup: funnel.signup, first_signal_seen: funnel.first_signal_seen, upgrade_intent: funnel.upgrade_intent, paid: funnel.paid },
    conversionPct: conversion,
    recent: funnel.events.slice(-50),
  };
}

module.exports = {
  applyTrial,
  welcomeEmail,
  paymentReceivedEmail,
  sendEmail,
  track,
  funnelSnapshot,
};
