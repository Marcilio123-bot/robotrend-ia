/**
 * Robotrend IA — Cupons + Feedback (SaaS aberto)
 *
 *   - Cupons de desconto (% off no preço, validade)
 *   - Feedback dos usuários (em memória/PG)
 *
 *   Sistema de convites (invite codes) foi REMOVIDO — cadastro é aberto.
 *   Em modo in-memory (default), tudo é persistido em ./data/beta.json.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { logger } = require('./logger');

const DATA_FILE = path.join(__dirname, '..', 'data', 'beta.json');

const state = {
  coupons: [],  // { code, type:'percent', value, plan, maxUses, used, expiresAt }
  feedback: [], // { userId, email, rating, text, createdAt }
};

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const data = JSON.parse(raw);
      // Migração: descarta state.invites legacy se existir
      if (data.invites) delete data.invites;
      Object.assign(state, data);
      logger.info('beta state loaded', {
        coupons: state.coupons.length,
        feedback: state.feedback.length,
      });
    }
  } catch (e) {
    logger.warn('beta state load failed', { err: e.message });
  }
}
function persist() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    logger.warn('beta state persist failed', { err: e.message });
  }
}
load();

/* ============================================================
   COUPONS
   ============================================================ */
function createCoupon({ code, percent, plan, maxUses, expiresAt }) {
  const c = {
    code: (code || crypto.randomBytes(3).toString('hex')).toUpperCase(),
    type: 'percent',
    value: Math.min(100, Math.max(1, Number(percent || 10))),
    plan: plan || 'ANY',
    maxUses: Number(maxUses || 100),
    used: 0,
    expiresAt: expiresAt || new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString(),
    createdAt: new Date().toISOString(),
  };
  state.coupons.push(c);
  persist();
  return c;
}

function applyCoupon(code, plan, basePrice) {
  const codeUp = String(code ?? '').trim().toUpperCase();
  const planUp = String(plan ?? '').trim().toUpperCase();
  const c = state.coupons.find((x) => x.code === codeUp);
  if (!c) return { ok: false, error: 'Cupom não encontrado' };
  if (c.used >= c.maxUses) return { ok: false, error: 'Cupom esgotado' };
  if (new Date(c.expiresAt) < new Date()) return { ok: false, error: 'Cupom expirado' };
  if (c.plan !== 'ANY' && c.plan !== planUp) return { ok: false, error: 'Cupom inválido para esse plano' };
  const discount = +(basePrice * (c.value / 100)).toFixed(2);
  const finalPrice = +(basePrice - discount).toFixed(2);
  return { ok: true, discount, finalPrice, coupon: c };
}

function commitCoupon(code) {
  const codeUp = String(code ?? '').trim().toUpperCase();
  const c = state.coupons.find((x) => x.code === codeUp);
  if (c) { c.used += 1; persist(); }
  return c;
}

function listCoupons() { return state.coupons.slice().reverse(); }

/* ============================================================
   FEEDBACK
   ============================================================ */
function addFeedback({ userId, email, rating, text, page }) {
  const f = {
    id: state.feedback.length + 1,
    userId, email,
    rating: Math.min(5, Math.max(1, Number(rating || 5))),
    text: String(text || '').slice(0, 2000),
    page: page || '/',
    createdAt: new Date().toISOString(),
  };
  state.feedback.push(f);
  if (state.feedback.length > 5000) state.feedback.shift();
  persist();
  return f;
}

function listFeedback(limit = 200) {
  return state.feedback.slice(-limit).reverse();
}

function feedbackStats() {
  if (!state.feedback.length) return { count: 0, avgRating: 0, byRating: {} };
  const avg = state.feedback.reduce((s, f) => s + f.rating, 0) / state.feedback.length;
  const byRating = state.feedback.reduce((acc, f) => { acc[f.rating] = (acc[f.rating] || 0) + 1; return acc; }, {});
  return { count: state.feedback.length, avgRating: +avg.toFixed(2), byRating };
}

module.exports = {
  createCoupon, applyCoupon, commitCoupon, listCoupons,
  addFeedback, listFeedback, feedbackStats,
};
