/* ============================================================
   ROBOTREND IA — System message visibility
   ------------------------------------------------------------
   Apenas admin_master (e roles master legadas) veem avisos técnicos:
   API, provider, debug, pipeline, quota, safe-mode, etc.
   Clientes Free/Premium veem só sinais reais e info essencial de jogos.
   ============================================================ */
(function () {
  'use strict';

  if (window.RobotrendSystemAccess) return;

  const SYSTEM_MESSAGE_ROLES = new Set([
    'admin_master',
    'master',
    'admin',
    'owner',
    'super_admin',
  ]);

  function normalizeRole(userOrRole) {
    if (userOrRole == null) return '';
    if (typeof userOrRole === 'string') return userOrRole.trim().toLowerCase();
    const u = userOrRole;
    return String(u.role || u.user?.role || '').trim().toLowerCase();
  }

  function resolveUserRole() {
    try {
      const us = window.RobotrendUser?.get?.();
      if (us) return normalizeRole(us);
      return normalizeRole(window.RobotrendAuth?.getUser?.());
    } catch {
      return '';
    }
  }

  function canViewSystemMessages(userOrRole) {
    const role = userOrRole != null && userOrRole !== ''
      ? normalizeRole(userOrRole)
      : resolveUserRole();
    return SYSTEM_MESSAGE_ROLES.has(role);
  }

  window.RobotrendSystemAccess = {
    SYSTEM_MESSAGE_ROLES,
    normalizeRole,
    resolveUserRole,
    canViewSystemMessages,
    /** Alias explícito pedido pelo produto. */
    isAdminMaster: canViewSystemMessages,
  };
})();
