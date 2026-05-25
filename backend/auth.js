/**
 * Robotrend IA — Autenticação
 *
 *  - Register / Login com JWT
 *  - Reset de senha via token de uso único (TTL 30min)
 *  - Middleware requireAuth + requireAdmin
 *  - Sessões opcionais (token armazenado em cookie httpOnly OU header)
 */

'use strict';

const crypto = require('crypto');
const bruteforce = require('./bruteforce');
const onboarding = require('./onboarding');
const { logger } = require('./logger');

let bcrypt;
try { bcrypt = require('bcryptjs'); } catch (e) { bcrypt = null; }
let jwt;
try { jwt = require('jsonwebtoken'); } catch (e) { jwt = null; }

const { getJwtSecret, isProductionLike } = require('./startup-check');
const JWT_SECRET = getJwtSecret();
if (!isProductionLike() && JWT_SECRET === 'robotrend_default_secret_change_me') {
  console.warn('[auth] JWT_SECRET ausente/fraco — usando default apenas em desenvolvimento');
}
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 10);

function ok() {
  if (!bcrypt || !jwt) {
    throw new Error('bcryptjs + jsonwebtoken não instalados. Rode `npm install`.');
  }
}

async function hashPassword(plain) {
  ok();
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

async function comparePassword(plain, hash) {
  ok();
  return bcrypt.compare(plain, hash);
}

function signToken(payload, opts = {}) {
  ok();
  return jwt.sign(payload, JWT_SECRET, { expiresIn: opts.expiresIn || JWT_EXPIRES_IN });
}

function verifyToken(token) {
  ok();
  try { return jwt.verify(token, JWT_SECRET); }
  catch (e) { return null; }
}

function randomToken(len = 32) {
  return crypto.randomBytes(len).toString('hex');
}

const COOKIE_NAME = 'rb_token';

function isProd() {
  const env = process.env.NODE_ENV || 'development';
  return env === 'production' || env === 'staging';
}

function buildCookie(value, { maxAge } = {}) {
  const parts = [`${COOKIE_NAME}=${value}`, 'HttpOnly', 'Path=/', 'SameSite=Strict'];
  if (isProd()) parts.push('Secure');
  if (typeof maxAge === 'number') parts.push(`Max-Age=${maxAge}`);
  return parts.join('; ');
}

function setAuthCookie(res, token, maxAgeSeconds = 7 * 24 * 3600) {
  res.setHeader('Set-Cookie', buildCookie(token, { maxAge: maxAgeSeconds }));
}

function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', buildCookie('', { maxAge: 0 }));
}

/**
 * Extrai token de Authorization header, cookie ou query.
 */
function extractToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  if (req.headers['x-auth-token']) return req.headers['x-auth-token'];
  if (req.query.token) return String(req.query.token);
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)rb_token=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Middleware: exige usuário autenticado.
 * @param {object} db - camada de banco
 */
function requireAuth(db) {
  return async (req, res, next) => {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ error: 'Não autenticado' });
    const payload = verifyToken(token);
    if (!payload || !payload.sub) return res.status(401).json({ error: 'Token inválido' });
    const user = await db.findUserById(payload.sub);
    if (!user) return res.status(401).json({ error: 'Usuário não encontrado' });
    req.user = sanitizeUser(user);
    next();
  };
}

/**
 * Auth opcional — pipeline interno / painel público.
 * Token inválido ou usuário ausente NÃO bloqueia a requisição.
 */
function optionalAuth(db) {
  return async (req, res, next) => {
    const token = extractToken(req);
    if (!token) return next();
    try {
      const payload = verifyToken(token);
      if (!payload?.sub) return next();
      const user = await db.findUserById(payload.sub);
      if (user) req.user = sanitizeUser(user);
    } catch (_) { /* token expirado/inválido — segue sem user */ }
    next();
  };
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Não autenticado', code: 'AUTH_REQUIRED' });
  const role = String(req.user.role || '').toLowerCase();
  if (role !== 'admin' && role !== 'owner') {
    return res.status(403).json({ error: 'Acesso negado: apenas administradores', code: 'ADMIN_REQUIRED' });
  }
  next();
}

/**
 * Middleware: exige role 'premium' OU 'admin' (features avançadas pagas).
 * Aceita também plan PREMIUM/PRO/VIP como equivalente a role premium
 * (compat com sistema antigo de planos).
 */
function requirePremium(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Não autenticado', code: 'AUTH_REQUIRED' });
  const role = String(req.user.role || '').toLowerCase();
  const plan = String(req.user.plan || '').toUpperCase();
  const ok = role === 'admin' || role === 'owner' || role === 'premium'
          || plan === 'PREMIUM' || plan === 'PRO' || plan === 'VIP';
  if (!ok) {
    return res.status(403).json({
      error: 'Recurso disponível apenas para assinantes Premium',
      code: 'PREMIUM_REQUIRED',
    });
  }
  next();
}

/**
 * Ambiente local/dev onde toggles LIVE/PRE-LIVE não exigem login.
 * NODE_ENV=development OU ALLOW_DEV_TOGGLE=true
 */
function isDevToggleBypass() {
  if (String(process.env.ALLOW_DEV_TOGGLE || '').toLowerCase() === 'true') return true;
  const env = process.env.NODE_ENV || 'development';
  return env === 'development';
}

/**
 * Auth para POST /api/live/toggle e /api/prelive/toggle.
 * - development: sempre permite (injeta usuário admin sintético se não logado)
 * - production: exige JWT válido + role admin
 */
function requireSystemToggle(db) {
  return async (req, res, next) => {
    if (isDevToggleBypass()) {
      const token = extractToken(req);
      if (token) {
        try {
          const payload = verifyToken(token);
          if (payload?.sub) {
            const user = await db.findUserById(payload.sub);
            if (user) req.user = sanitizeUser(user);
          }
        } catch (_) { /* ignore */ }
      }
      if (!req.user) {
        req.user = { id: 'dev-local', role: 'admin', email: 'dev@localhost', plan: 'PREMIUM', name: 'Dev' };
      }
      return next();
    }

    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Não autenticado', code: 'AUTH_REQUIRED' });
    }
    const payload = verifyToken(token);
    if (!payload?.sub) {
      return res.status(401).json({ error: 'Token inválido', code: 'TOKEN_INVALID' });
    }
    const user = await db.findUserById(payload.sub);
    if (!user) {
      return res.status(401).json({ error: 'Usuário não encontrado', code: 'USER_NOT_FOUND' });
    }
    req.user = sanitizeUser(user);
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        error: 'Apenas administradores podem alternar LIVE/PRE-LIVE',
        code: 'ADMIN_REQUIRED',
      });
    }
    return next();
  };
}

function sanitizeUser(u) {
  if (!u) return null;
  const { passwordHash, resetToken, resetTokenExpires, ...rest } = u;
  // Garante role + plan sempre presentes (defaults seguros).
  // Roles: 'user' (padrão), 'premium' (cliente pago), 'admin' (acesso total).
  const safe = Object.assign({}, rest, {
    role: rest.role || 'user',
    plan: rest.plan || 'FREE',
  });
  return safe;
}

/* ============================================================
   HANDLERS REST
   ============================================================ */

function buildAuthRoutes(app, db) {
  /**
   * POST /api/auth/register
   * ------------------------------------------------------------
   * Cadastro simples: nome (opcional), email, senha.
   * Sem sistema de convite. Sem trial automático. Cria como FREE.
   *
   * Códigos de erro retornados:
   *   400 EMAIL_PASSWORD_REQUIRED  — email ou senha ausente/vazio
   *   400 PASSWORD_TOO_SHORT       — senha < 6 caracteres
   *   400 INVALID_EMAIL            — email malformado
   *   409 EMAIL_ALREADY_EXISTS     — já cadastrado
   *   500 SERVER_ERROR             — erro interno
   */
  app.post('/api/auth/register', async (req, res) => {
    try {
      // Trim DEFENSIVO em cada campo — protege contra undefined/null/number
      const body = req.body || {};
      const email    = String(body.email    ?? '').trim().toLowerCase();
      const password = String(body.password ?? '').trim();
      const name     = String(body.name     ?? '').trim();

      // Validação obrigatória
      if (!email || !password) {
        return res.status(400).json({ error: 'EMAIL_PASSWORD_REQUIRED' });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'INVALID_EMAIL' });
      }
      if (password.length < 6) {
        return res.status(400).json({ error: 'PASSWORD_TOO_SHORT' });
      }

      const exists = await db.findUserByEmail(email);
      if (exists) return res.status(409).json({ error: 'EMAIL_ALREADY_EXISTS' });

      const passwordHash = await hashPassword(password);
      const user = await db.createUser({
        email,
        name: name || email.split('@')[0],
        passwordHash,
        plan: 'FREE',
        role: 'user',
      });

      // Trial Premium opt-in (default OFF). Ative com TRIAL_ON_SIGNUP=true.
      const trialOnSignup = String(process.env.TRIAL_ON_SIGNUP || 'false').toLowerCase() === 'true';
      try {
        if (trialOnSignup) {
          const expires = await onboarding.applyTrial(db, user);
          const fresh = await db.findUserById(user.id);
          user.plan = fresh?.plan || 'PREMIUM';
          onboarding.track('signup', { userId: user.id, plan: user.plan, trialUntil: expires });
        } else {
          onboarding.track('signup', { userId: user.id, plan: user.plan });
        }
        await onboarding.welcomeEmail(user);
      } catch (err) {
        logger.warn('welcome falhou', { err: err.message });
      }

      const token = signToken({ sub: user.id, role: user.role, plan: user.plan });
      setAuthCookie(res, token);
      logger.info('user registered', { email: user.email, userId: user.id });
      res.json({ ok: true, token, user: sanitizeUser(user) });
    } catch (e) {
      logger.error('register error', { err: e.message, stack: e.stack });
      res.status(500).json({ error: 'SERVER_ERROR', detail: e.message });
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    const isDev = !isProd();
    try {
      // Trim defensivo
      const body = req.body || {};
      const email    = String(body.email    ?? '').trim().toLowerCase();
      const password = String(body.password ?? '').trim();
      if (!email || !password) {
        console.log(`[AUTH LOGIN] rejeitado email="${email}" motivo=EMAIL_PASSWORD_REQUIRED`);
        return res.status(400).json({ error: 'EMAIL_PASSWORD_REQUIRED' });
      }

      const ip = req.ip || req.connection?.remoteAddress || 'unknown';
      const bfKey = `${email}:${ip}`;

      // Em dev, bruteforce é DESLIGADO (default) — pode reativar com BRUTEFORCE_ENABLED_DEV=true.
      // Em produção/staging, sempre ativo.
      const bruteforceEnabled = !isDev || String(process.env.BRUTEFORCE_ENABLED_DEV || '').toLowerCase() === 'true';
      if (bruteforceEnabled) {
        const blockStatus = bruteforce.status(bfKey);
        if (blockStatus.blocked) {
          console.log(`[AUTH LOGIN] BLOQUEADO email="${email}" ip=${ip} motivo=BRUTEFORCE_LOCK restante=${blockStatus.secondsRemaining}s`);
          return res.status(429).json({
            error: 'Muitas tentativas falhas. Tente novamente em breve.',
            secondsRemaining: blockStatus.secondsRemaining,
          });
        }
      }

      const user = await db.findUserByEmail(email);
      if (!user) {
        if (bruteforceEnabled) bruteforce.recordFail(bfKey);
        console.log(`[AUTH LOGIN] FALHOU email="${email}" ip=${ip} motivo=USER_NOT_FOUND`);
        return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
      }
      const okPw = await comparePassword(password, user.passwordHash);
      if (!okPw) {
        const e = bruteforceEnabled ? bruteforce.recordFail(bfKey) : { fails: 0 };
        console.log(`[AUTH LOGIN] FALHOU email="${email}" ip=${ip} motivo=INVALID_PASSWORD fails=${e.fails}`);
        logger.warn('login fail', { email, ip, fails: e.fails });
        return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
      }
      if (bruteforceEnabled) bruteforce.recordSuccess(bfKey);

      const token = signToken({ sub: user.id, role: user.role, plan: user.plan });
      setAuthCookie(res, token);
      console.log(`[AUTH LOGIN] OK email="${email}" id=${user.id} role=${user.role} plan=${user.plan}`);
      logger.info('user login', { email: user.email, userId: user.id });
      res.json({ ok: true, token, user: sanitizeUser(user) });
    } catch (e) {
      console.log(`[AUTH LOGIN] ERRO motivo=${e.message}`);
      logger.error('login error', { err: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    clearAuthCookie(res);
    res.json({ ok: true });
  });

  app.get('/api/auth/me', requireAuth(db), (req, res) => {
    // req.user já foi normalizado por sanitizeUser → garante role + plan
    res.json({ user: req.user });
  });

  // Endpoint público de verificação rápida de role (para guards do frontend).
  // Não retorna PII, apenas authenticated, role e plan.
  app.get('/api/auth/check', async (req, res) => {
    const token = extractToken(req);
    if (!token) return res.json({ authenticated: false });
    const payload = verifyToken(token);
    if (!payload?.sub) return res.json({ authenticated: false });
    const user = await db.findUserById(payload.sub);
    if (!user) return res.json({ authenticated: false });
    const safe = sanitizeUser(user);
    res.json({
      authenticated: true,
      role: safe.role,
      plan: safe.plan,
      email: safe.email,
      name: safe.name,
    });
  });

  app.post('/api/auth/forgot', async (req, res) => {
    try {
      const body = req.body || {};
      const email = String(body.email ?? '').trim().toLowerCase();
      if (!email) return res.status(400).json({ error: 'EMAIL_REQUIRED' });
      const user = await db.findUserByEmail(email);
      // Resposta uniforme p/ não vazar existência de email
      if (!user) return res.json({ ok: true, message: 'Se o email existir, instruções foram enviadas.' });

      const token = randomToken(24);
      const expires = Date.now() + 30 * 60 * 1000;
      await db.setResetToken(user.id, token, expires);

      // Em produção: enviar email. Aqui: retornamos no dev e logamos.
      const link = `${process.env.PUBLIC_URL || 'http://localhost:3010'}/reset.html?token=${token}`;
      console.log('[auth] reset link gerado para', email, '→', link);
      res.json({
        ok: true,
        message: 'Se o email existir, instruções foram enviadas.',
        devLink: process.env.NODE_ENV !== 'production' ? link : undefined,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/auth/reset', async (req, res) => {
    try {
      const body = req.body || {};
      const token    = String(body.token    ?? '').trim();
      const password = String(body.password ?? '').trim();
      if (!token || !password) return res.status(400).json({ error: 'TOKEN_PASSWORD_REQUIRED' });
      if (password.length < 6) return res.status(400).json({ error: 'PASSWORD_TOO_SHORT' });
      const user = await db.findUserByResetToken(token);
      if (!user) return res.status(400).json({ error: 'INVALID_OR_EXPIRED_TOKEN' });
      const passwordHash = await hashPassword(password);
      await db.updateUser(user.id, { passwordHash, resetToken: null, resetTokenExpires: null });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/auth/change-password', requireAuth(db), async (req, res) => {
    try {
      const body = req.body || {};
      const current = String(body.current ?? '').trim();
      const next    = String(body.next    ?? '').trim();
      if (!current || !next) return res.status(400).json({ error: 'CURRENT_NEXT_REQUIRED' });
      if (next.length < 6) return res.status(400).json({ error: 'PASSWORD_TOO_SHORT' });
      const user = await db.findUserById(req.user.id);
      const okPw = await comparePassword(current, user.passwordHash);
      if (!okPw) return res.status(401).json({ error: 'INVALID_CURRENT_PASSWORD' });
      const passwordHash = await hashPassword(next);
      await db.updateUser(user.id, { passwordHash });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = {
  hashPassword,
  comparePassword,
  signToken,
  verifyToken,
  extractToken,
  requireAuth,
  optionalAuth,
  requireAdmin,
  requirePremium,
  requireSystemToggle,
  isDevToggleBypass,
  sanitizeUser,
  randomToken,
  setAuthCookie,
  clearAuthCookie,
  buildAuthRoutes,
};
