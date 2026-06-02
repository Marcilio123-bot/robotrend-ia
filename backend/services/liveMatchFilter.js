/**
 * Filtro compartilhado — define o que é "realmente ao vivo" no poller e nas rotas REST.
 * Uma única fonte de verdade evita drift entre liveFootballPoller e /api/football/live.
 */

'use strict';

/** Kickoff entre 30 min antes e 4 h depois (janela máxima de jogo + prorrogação). */
const KICKOFF_PAST_H_MAX = Number(process.env.FOOTBALL_LIVE_KICKOFF_PAST_H || 4);
const KICKOFF_FUTURE_H_MAX = Number(process.env.FOOTBALL_LIVE_KICKOFF_FUTURE_H || 0.5);

const LIVE_STATUSES = new Set([
  '1H', 'HT', '2H', 'ET', 'BT', 'LIVE', 'INT', 'P',
  'INPLAY', 'IN_PLAY', 'IN-PLAY', 'IN PROGRESS', 'IN_PROGRESS',
  'INPROGRESS', 'IN-PROGRESS',
]);
const NS_STATUSES = new Set([
  'NS', 'NOT STARTED', 'NOTSTARTED', 'NOT_STARTED',
  'SCHEDULED', 'TIMED',
]);
const FT_STATUSES = new Set([
  'FT', 'AET', 'PEN', 'AWD', 'WO', 'ABD', 'CANC',
  'FINISHED', 'MATCH FINISHED', 'AFTER PENALTIES', 'AFTER EXTRA TIME',
  'CANCELLED', 'POSTPONED', 'PST', 'SUSP', 'SUSPENDED',
]);
const HT_STATUSES = new Set(['HT', 'HALFTIME', 'HALF TIME']);

function kickoffHoursFromNow(m) {
  const raw = m?.kickoffAt || m?.date || m?.fixture?.date;
  if (!raw) return null;
  const t = new Date(raw).getTime();
  if (!Number.isFinite(t)) return null;
  return (t - Date.now()) / 3_600_000;
}

/** Kickoff dentro da janela jogável (não aceita partida de dias atrás). */
function isKickoffInPlayWindow(m) {
  const h = kickoffHoursFromNow(m);
  if (h == null) return false;
  return h >= -KICKOFF_PAST_H_MAX && h <= KICKOFF_FUTURE_H_MAX;
}

function statusGroup(m) {
  const sRaw = String(m?.status || '').toUpperCase().trim();
  const longRaw = String(m?.statusLong || '').toUpperCase().trim();
  const min = Number(m?.minute || 0);

  if (FT_STATUSES.has(sRaw) || FT_STATUSES.has(longRaw)) return 'FT';
  if (min > 0 && min < 120) {
    if (LIVE_STATUSES.has(sRaw) || LIVE_STATUSES.has(longRaw) || !sRaw) return 'LIVE';
  }
  if (LIVE_STATUSES.has(sRaw) || LIVE_STATUSES.has(longRaw)) return 'LIVE';
  if (HT_STATUSES.has(sRaw) || HT_STATUSES.has(longRaw)) return 'HT';
  if (NS_STATUSES.has(sRaw) || NS_STATUSES.has(longRaw)) return 'NS';
  if (isKickoffInPlayWindow(m)) return 'LIVE';
  return 'NS';
}

/** True se o match deve aparecer no painel live/scanner. */
function isLiveMatch(m) {
  if (!m) return false;
  const grp = statusGroup(m);
  if (grp === 'FT') return false;

  const min = Number(m?.minute || 0);
  if (min >= 120) return false;

  const h = kickoffHoursFromNow(m);

  if (grp === 'NS') {
    // NS sem kickoff na janela = agendamento antigo ainda listado pelo provider
    if (h == null) return false;
    if (h < -KICKOFF_PAST_H_MAX) return false;
    if (h > 24) return false;
    return isKickoffInPlayWindow(m);
  }

  // LIVE/HT: kickoff muito antigo = fixture fantasma (status/minuto desatualizados)
  if (h != null && h < -KICKOFF_PAST_H_MAX) return false;

  return grp === 'LIVE' || grp === 'HT';
}

function matchDebugFields(m) {
  return {
    id: m?.id != null ? String(m.id) : null,
    status: m?.status ?? null,
    statusLong: m?.statusLong ?? null,
    minute: m?.minute ?? null,
    kickoffAt: m?.kickoffAt || m?.date || null,
    kickoffHoursFromNow: kickoffHoursFromNow(m),
    provider: m?.provider || m?.flags?.source || null,
    group: statusGroup(m),
  };
}

module.exports = {
  isLiveMatch,
  statusGroup,
  matchDebugFields,
  isKickoffInPlayWindow,
  kickoffHoursFromNow,
  LIVE_STATUSES,
  NS_STATUSES,
  FT_STATUSES,
  HT_STATUSES,
};
