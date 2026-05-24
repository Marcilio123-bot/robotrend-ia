/**
 * Robotrend IA — Camada de Segurança
 *
 *   - helmet (CSP relaxado para CDN Tailwind + Google Fonts)
 *   - rate-limit (gerenciado por IP)
 *   - validação leve de body (sem libs externas)
 *   - sanitização básica de strings
 */

'use strict';

let helmet, rateLimit;
try { helmet = require('helmet'); } catch (e) { helmet = null; }
try { rateLimit = require('express-rate-limit'); } catch (e) { rateLimit = null; }

const WINDOW = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000);
const MAX    = Number(process.env.RATE_LIMIT_MAX || 120);

function buildCspDirectives() {
  return {
    "default-src": ["'self'"],
    "script-src": [
      "'self'",
      "'unsafe-inline'",
    ],
    "style-src": [
      "'self'",
      "'unsafe-inline'",
      "https://fonts.googleapis.com",
    ],
    "font-src": [
      "'self'",
      "https://fonts.gstatic.com",
      "data:",
    ],
    "img-src": [
      "'self'",
      "data:",
      "blob:",
      "https:",
    ],
    "connect-src": [
      "'self'",
      "ws:",
      "wss:",
      "http://localhost:*",
      "ws://localhost:*",
      "wss://localhost:*",
      "https://fonts.googleapis.com",
      "https://fonts.gstatic.com",
      "https://api.qrserver.com",
      "https://media.api-sports.io",
    ],
    "worker-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'self'"],
    "object-src": ["'none'"],
    // upgrade-insecure-requests omitido de propósito (quebra ws/http em localhost:3010)
  };
}

function applySecurity(app) {
  if (helmet) {
    app.use(
      helmet({
        contentSecurityPolicy: {
          useDefaults: false,
          directives: buildCspDirectives(),
        },
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: { policy: 'cross-origin' },
      })
    );
  } else {
    console.warn('[security] helmet não instalado, pulando CSP.');
  }

  if (rateLimit) {
    const generalLimiter = rateLimit({
      windowMs: WINDOW,
      max: MAX,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Muitas requisições — aguarde alguns instantes.' },
    });
    const authLimiter = rateLimit({
      windowMs: 60_000,
      max: 10,
      message: { error: 'Muitas tentativas de autenticação. Tente novamente em 1 min.' },
    });
    app.use('/api/', generalLimiter);
    app.use(['/api/auth/login', '/api/auth/register', '/api/auth/forgot', '/api/auth/reset'], authLimiter);
  } else {
    console.warn('[security] express-rate-limit não instalado.');
  }
}

/* ============================================================
   VALIDATION (sem deps)
   ============================================================ */
const isEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

function validate(schema) {
  return (req, res, next) => {
    const errors = [];
    for (const [field, rule] of Object.entries(schema)) {
      const value = (req.body || {})[field];
      if (rule.required && (value === undefined || value === null || value === '')) {
        errors.push(`${field} é obrigatório`); continue;
      }
      if (value === undefined) continue;
      if (rule.type === 'string' && typeof value !== 'string') errors.push(`${field} deve ser string`);
      if (rule.type === 'number' && typeof value !== 'number') errors.push(`${field} deve ser número`);
      if (rule.type === 'email'  && !isEmail(value))           errors.push(`${field} deve ser email válido`);
      if (rule.min   && String(value).length < rule.min) errors.push(`${field} mínimo ${rule.min}`);
      if (rule.max   && String(value).length > rule.max) errors.push(`${field} máximo ${rule.max}`);
      if (rule.enum  && !rule.enum.includes(value))       errors.push(`${field} deve ser um de: ${rule.enum.join(', ')}`);
    }
    if (errors.length) return res.status(400).json({ error: 'Validação falhou', details: errors });
    next();
  };
}

function sanitize(str, max = 200) {
  if (typeof str !== 'string') return str;
  return str.replace(/[<>]/g, '').slice(0, max).trim();
}

module.exports = { applySecurity, validate, sanitize, isEmail };
