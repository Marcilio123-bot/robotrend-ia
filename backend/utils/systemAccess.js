'use strict';

/**
 * Quem pode ver mensagens técnicas do sistema (API, debug, pipeline, quota).
 * Clientes Free/Premium veem apenas sinais reais e dados essenciais das partidas.
 */
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
  return String(userOrRole.role || '').trim().toLowerCase();
}

function canViewSystemMessages(userOrRole) {
  return SYSTEM_MESSAGE_ROLES.has(normalizeRole(userOrRole));
}

/**
 * Remove campos técnicos de respostas live/scanner para clientes.
 */
function projectPublicLivePayload(body, user) {
  if (!body || typeof body !== 'object') return body;
  if (canViewSystemMessages(user)) return body;

  const out = { ...body };
  delete out.safeMode;
  delete out.provider;
  delete out.hint;
  delete out.consensus;

  if (Array.isArray(out.matches) && out.matches.length === 0) {
    out.reason = 'no-live-matches';
  } else {
    delete out.reason;
  }

  if (out.meta && typeof out.meta === 'object') {
    out.meta = {
      totalReceived: out.meta.totalAfterFilter ?? out.meta.totalReceived ?? (out.matches?.length || 0),
      totalAfterFilter: out.meta.totalAfterFilter ?? (out.matches?.length || 0),
    };
  }

  return out;
}

module.exports = {
  SYSTEM_MESSAGE_ROLES,
  normalizeRole,
  canViewSystemMessages,
  projectPublicLivePayload,
};
