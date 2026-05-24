/* ============================================================
   ROBOTREND IA — Auth Guard (frontend)
   Controle de acesso baseado em role + plan.

   Como usar:
     <meta name="robotrend-guard" content="user">     → exige login
     <meta name="robotrend-guard" content="premium">  → exige role=premium OU role=admin OU plan PREMIUM
     <meta name="robotrend-guard" content="admin">    → exige role=admin (ou owner)

   Sem meta = página pública (login, register, pricing, etc).

   Fluxo:
     1) Lê o user cacheado do localStorage (render imediato).
     2) Chama /api/auth/me em paralelo para confirmar (defesa contra token revogado).
     3) Se faltar permissão → redirect imediato:
         - sem token   → /login.html?next=...
         - admin neg.  → /index.html?denied=...
         - premium neg → /pricing.html?upgrade=...
     4) Dispara evento 'robotrend:user-ready' para outros scripts (saas-nav)
        rerenderizarem com user atualizado.

   IMPORTANTE: o guard frontend é UX. A segurança REAL está no backend
   (requireAuth + requireAdmin em todas as rotas /api/admin/*).
   ============================================================ */
(function () {
  'use strict';

  const meta = document.querySelector('meta[name="robotrend-guard"]');
  const required = meta?.content?.toLowerCase() || null;

  // Páginas sem guard = públicas (login, register, pricing, etc)
  if (!required) {
    window.RobotrendGuard = { required: null, ready: Promise.resolve(null) };
    return;
  }

  // Anti-flash: esconde o conteúdo até o guard validar (revela após o STEP 1
  // ou no STEP 2 quando confirma). Se redirecionar, mantemos escondido.
  const styleEl = document.createElement('style');
  styleEl.id = 'robotrend-guard-style';
  styleEl.textContent = 'html.robotrend-guarding body { visibility: hidden !important; }';
  document.head.appendChild(styleEl);
  document.documentElement.classList.add('robotrend-guarding');
  function revealBody() {
    document.documentElement.classList.remove('robotrend-guarding');
  }

  const isLocalDev = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const ALLOW_DEV = String(window.__ROBOTREND_DEV_BYPASS || '').toLowerCase() === 'true';

  function hasRole(user, role) {
    if (!user) return false;
    const r = String(user.role || '').toLowerCase();
    return r === role;
  }

  function isAdmin(user) {
    if (!user) return false;
    const r = String(user.role || '').toLowerCase();
    return r === 'admin' || r === 'owner';
  }

  function isPremium(user) {
    if (!user) return false;
    if (isAdmin(user)) return true;
    const r = String(user.role || '').toLowerCase();
    const p = String(user.plan || '').toUpperCase();
    return r === 'premium' || p === 'PREMIUM' || p === 'PRO' || p === 'VIP' || p === 'TRIAL';
  }

  function redirect(url) {
    // Esconde o body para evitar flash do conteúdo protegido
    try { document.documentElement.style.visibility = 'hidden'; } catch (_) {}
    location.href = url;
  }

  function checkAccess(user) {
    if (required === 'user') return !!user;
    if (required === 'admin') return isAdmin(user);
    if (required === 'premium') return isPremium(user);
    return true; // unknown level = permissivo (mas log warn)
  }

  function denialUrl() {
    const back = encodeURIComponent(location.pathname + location.search);
    if (required === 'admin') return `/index.html?denied=${back}`;
    if (required === 'premium') return `/pricing.html?upgrade=${back}`;
    return `/login.html?next=${back}`;
  }

  // ============ STEP 1: cache local (render rápido) ============
  const auth = window.RobotrendAuth;
  if (!auth) {
    console.warn('[auth-guard] RobotrendAuth não carregado — guard ignorado');
    window.RobotrendGuard = { required, ready: Promise.resolve(null) };
    return;
  }

  const token = auth.getToken();
  const cachedUser = auth.getUser();

  // Sem token = não autenticado → redirect para login
  if (!token) {
    if (isLocalDev && ALLOW_DEV && required !== 'admin') {
      // Apenas dev local: deixa passar como visitor para iterar a UI
      console.warn('[auth-guard] DEV bypass ativo — acesso liberado em', location.pathname);
      revealBody();
      window.RobotrendGuard = { required, ready: Promise.resolve(null) };
      return;
    }
    redirect(`/login.html?next=${encodeURIComponent(location.pathname + location.search)}`);
    return;
  }

  // Cache hit não-conformante (ex: user salvou como admin mas perdeu role no server)?
  // Vamos validar de qualquer forma com server-side check.
  if (cachedUser && !checkAccess(cachedUser)) {
    redirect(denialUrl());
    return;
  }

  // Cache válido para a role exigida → revela imediatamente.
  // STEP 2 ainda valida em background.
  if (cachedUser && checkAccess(cachedUser)) {
    revealBody();
  }

  // ============ STEP 2: confirmação server-side (assíncrona) ============
  const ready = (async () => {
    try {
      const me = await auth.api('/api/auth/me');
      const user = me?.user;
      if (!user) {
        redirect(`/login.html?next=${encodeURIComponent(location.pathname)}`);
        return null;
      }
      // Atualiza cache local com user fresco do server
      auth.setSession(token, user);
      if (!checkAccess(user)) {
        redirect(denialUrl());
        return null;
      }
      revealBody();
      window.dispatchEvent(new CustomEvent('robotrend:user-ready', { detail: user }));
      return user;
    } catch (err) {
      // Token expirado/revogado/inválido → limpa e manda pro login
      console.warn('[auth-guard] /me falhou:', err?.message);
      auth.clearSession?.();
      redirect(`/login.html?next=${encodeURIComponent(location.pathname)}`);
      return null;
    }
  })();

  /**
   * Refaz /api/auth/me, atualiza cache local e dispara `robotrend:user-ready`.
   * Usado após webhook MP confirmar pagamento → frontend não precisa deslogar.
   *
   * @returns {Promise<object|null>} user atualizado, ou null se token inválido
   */
  async function refreshUser() {
    try {
      const me = await auth.api('/api/auth/me');
      const user = me?.user;
      if (!user) return null;
      auth.setSession(auth.getToken(), user);
      window.dispatchEvent(new CustomEvent('robotrend:user-ready', { detail: user }));
      return user;
    } catch (err) {
      console.warn('[auth-guard] refreshUser falhou:', err?.message);
      return null;
    }
  }

  window.RobotrendGuard = {
    required,
    ready,
    refreshUser,
    isAdmin: () => isAdmin(auth.getUser()),
    isPremium: () => isPremium(auth.getUser()),
  };
})();
