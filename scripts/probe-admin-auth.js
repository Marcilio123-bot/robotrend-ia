#!/usr/bin/env node
'use strict';
/**
 * Diagnóstico: valores admin após login (sem alterar código).
 * Uso: node scripts/probe-admin-auth.js [email] [password]
 */
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
try {
  require('dotenv').config({ path: path.join(root, '.env') });
} catch (_) {}

const email = (process.argv[2] || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@robotrend.local').trim().toLowerCase();
const password = process.argv[3] || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change_me_in_environment';

const auth = require(path.join(root, 'backend', 'auth'));
const subscription = require(path.join(root, 'backend', 'subscription'));
const db = require(path.join(root, 'backend', 'database'));

function pickUserFields(u) {
  if (!u) return null;
  return {
    email: u.email,
    role: u.role,
    plan: u.plan,
    isAdmin: u.isAdmin,
  };
}

function decodeJwtPayload(token) {
  try {
    const payload = auth.verifyToken(token);
    if (!payload) return null;
    return {
      sub: payload.sub,
      role: payload.role,
      plan: payload.plan,
      isAdmin: subscription.isAdminUser({ role: payload.role }),
      note: 'JWT não inclui isAdmin — calculado a partir de role',
    };
  } catch (e) {
    return { error: e.message };
  }
}

function loginRedirectDecision(user) {
  const role = String(user?.role || '').toLowerCase();
  const isAdmin = user?.isAdmin === true
    || ['master', 'admin', 'owner', 'super_admin'].includes(role);
  return {
    condition: 'login.html: !next → isAdmin ? /master : /',
    roleChecked: role,
    isAdminComputed: isAdmin,
    destination: isAdmin ? '/master' : '/',
    usesPlan: false,
  };
}

async function probeDb() {
  await db.init();
  const user = await db.findUserByEmail(email);
  const sanitized = user ? auth.sanitizeUser(user) : null;
  return {
    source: 'database (findUserByEmail)',
    emailQueried: email,
    rawDb: user ? pickUserFields({ ...user, isAdmin: subscription.isAdminUser(user) }) : null,
    afterSanitize: pickUserFields(sanitized),
  };
}

async function probeLoginApi() {
  const base = process.env.PUBLIC_URL || process.env.BASE_URL || 'http://localhost:3010';
  const url = `${base.replace(/\/$/, '')}/api/auth/login`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { source: 'POST /api/auth/login', ok: false, status: res.status, error: data.error || data };
    }
    const user = data.user;
    const token = data.token;
    const localStorageUser = user;
    return {
      source: 'POST /api/auth/login (HTTP real)',
      ok: true,
      status: res.status,
      localStorage: {
        robotrend_token: token ? `${token.slice(0, 20)}… (${token.length} chars)` : null,
        robotrend_user: pickUserFields(localStorageUser),
      },
      jwt: decodeJwtPayload(token),
      apiAuthMeWouldMatch: pickUserFields(user),
      redirect: loginRedirectDecision(user),
    };
  } catch (e) {
    return { source: 'POST /api/auth/login', ok: false, error: e.message, hint: 'Servidor offline? Rode npm start na porta 3010.' };
  }
}

async function probeAuthMe(token) {
  if (!token) return null;
  const base = process.env.PUBLIC_URL || process.env.BASE_URL || 'http://localhost:3010';
  const url = `${base.replace(/\/$/, '')}/api/auth/me`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      credentials: 'include',
    });
    const data = await res.json().catch(() => ({}));
    return {
      source: 'GET /api/auth/me',
      ok: res.ok,
      status: res.status,
      user: pickUserFields(data.user),
    };
  } catch (e) {
    return { source: 'GET /api/auth/me', error: e.message };
  }
}

async function probeSimulatedLogin() {
  await db.init();
  let user = await db.findUserByEmail(email);
  if (!user) {
    return { source: 'simulated login', error: `Usuário não encontrado: ${email}` };
  }
  user = await subscription.syncSubscriptionStatus(db, user);
  const sanitized = auth.sanitizeUser(user);
  const token = auth.signToken({ sub: user.id, role: user.role, plan: user.plan });
  return {
    source: 'simulated login (mesmo fluxo do backend auth.js)',
    localStorage: {
      robotrend_user: pickUserFields(sanitized),
    },
    jwt: decodeJwtPayload(token),
    redirect: loginRedirectDecision(sanitized),
    authMe: pickUserFields(sanitized),
  };
}

(async () => {
  const out = {
    probedAt: new Date().toISOString(),
    credentialsUsed: { email, passwordLength: password.length },
    database: null,
    httpLogin: null,
    httpMe: null,
    simulated: null,
  };

  try {
    out.database = await probeDb();
  } catch (e) {
    out.database = { error: e.message, stack: e.stack };
  }

  try {
    out.simulated = await probeSimulatedLogin();
  } catch (e) {
    out.simulated = { error: e.message, stack: e.stack };
  }

  out.httpLogin = await probeLoginApi();
  if (out.httpLogin?.ok && out.httpLogin.localStorage) {
    const fullToken = await (async () => {
      const base = process.env.PUBLIC_URL || 'http://localhost:3010';
      const res = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const d = await res.json();
      return d.token;
    })();
    out.httpMe = await probeAuthMe(fullToken);
  }

  const reportPath = path.join(root, 'scripts', 'probe-admin-auth-result.json');
  fs.writeFileSync(reportPath, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
})();
