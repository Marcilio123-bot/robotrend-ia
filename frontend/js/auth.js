/* Robotrend IA — Lib de Autenticação (cliente) */
(function (global) {
  'use strict';

  const TOKEN_KEY = 'robotrend.token';
  const USER_KEY = 'robotrend.user';

  function getToken()  { return localStorage.getItem(TOKEN_KEY); }
  function getUser()   {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); }
    catch { return null; }
  }
  function setSession(token, user) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  }
  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }

  async function api(path, opts = {}) {
    const headers = Object.assign(
      { 'Content-Type': 'application/json' },
      opts.headers || {},
    );
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(path, {
      ...opts,
      headers,
      credentials: 'include', // cookie rb_token (login httpOnly)
    });
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('application/json') ? await res.json() : await res.text();
    if (!res.ok) {
      const msg = (data && data.error) || res.statusText;
      const code = data && data.code;
      if (res.status === 401 && /usuário não encontrado|não autenticado|token inválido/i.test(msg)) {
        clearSession();
      }
      // Conta bloqueada pelo admin — limpa sessão e força redirect ao login
      // com aviso (a página de login lê ?reason=blocked para mostrar mensagem).
      if (res.status === 403 && code === 'USER_BLOCKED') {
        clearSession();
        try {
          if (!location.pathname.startsWith('/login')) {
            location.replace('/login.html?reason=blocked');
          }
        } catch (_) {}
      }
      const err = new Error(msg);
      err.payload = data;
      err.code = code;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function register(email, password, name) {
    // Trim defensivo em cada campo — evita erro se vier undefined
    const payload = {
      email:    (email    ?? '').toString().trim().toLowerCase(),
      password: (password ?? '').toString().trim(),
      name:     (name     ?? '').toString().trim(),
    };
    const r = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    setSession(r.token, r.user);
    return r;
  }

  async function login(email, password) {
    const payload = {
      email:    (email    ?? '').toString().trim().toLowerCase(),
      password: (password ?? '').toString().trim(),
    };
    const r = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    setSession(r.token, r.user);
    return r;
  }

  async function logout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } catch (_) { /* offline ok */ }
    clearSession();
    location.href = '/login.html';
  }

  async function ensureAuth() {
    if (!getToken()) {
      location.href = '/login.html?next=' + encodeURIComponent(location.pathname);
      return null;
    }
    try {
      const me = await api('/api/auth/me');
      setSession(getToken(), me.user);
      return me.user;
    } catch (e) {
      clearSession();
      location.href = '/login.html';
      return null;
    }
  }

  global.RobotrendAuth = {
    getToken, getUser, setSession, clearSession,
    api, register, login, logout, ensureAuth,
  };
})(window);
