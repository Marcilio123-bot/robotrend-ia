/**
 * Robotrend IA — Freshness Guard
 *
 *   Garante que NUNCA processamos partidas antigas:
 *     ✅ Live em status válido (1H/2H/HT/ET/LIVE)
 *     ✅ Partidas iniciadas há ≤ 3h
 *     ✅ Próximas 24h (pré-live)
 *   ❌ Partidas com status finalizado (FT/AET/PEN/CANC/PST/ABD…)
 *   ❌ Partidas iniciadas há > 3h
 *   ❌ Partidas futuras > 24h
 *
 *   Defesa em camadas: scanners (live/prelive) usam isRecentMatch().
 *   analyzer.js também valida.
 *   telegram.js valida no last-mile antes do sendMessage.
 */

'use strict';

const PAST_HOURS_LIMIT   = Number(process.env.FRESHNESS_PAST_HOURS   || 3);
const FUTURE_HOURS_LIMIT = Number(process.env.FRESHNESS_FUTURE_HOURS || 24);

// Status que indicam jogo AO VIVO (sempre aceitar)
const LIVE_STATUSES = new Set([
  '1H',   // 1º tempo
  '2H',   // 2º tempo
  'HT',   // intervalo
  'ET',   // prorrogação
  'BT',   // intervalo da prorrogação
  'P',    // pênaltis (ainda em andamento)
  'LIVE', // genérico
  'INT',  // intervalo (alguns providers)
]);

// Status que indicam jogo ENCERRADO / inválido (sempre rejeitar)
const FINISHED_STATUSES = new Set([
  'FT',   // tempo regulamentar encerrado
  'AET',  // após prorrogação
  'PEN',  // após pênaltis
  'CANC', // cancelado
  'PST',  // adiado
  'ABD',  // abandonado
  'AWD',  // walkover decisão técnica
  'WO',   // walkover
  'SUSP', // suspenso
]);

function isLiveStatus(s)     { return s && LIVE_STATUSES.has(String(s).toUpperCase()); }
function isFinishedStatus(s) { return s && FINISHED_STATUSES.has(String(s).toUpperCase()); }

/**
 * Extrai timestamp do match em vários formatos comuns.
 * Retorna null se não houver pista.
 */
function getMatchTimestamp(match) {
  if (!match) return null;
  const candidates = [
    match.kickoffAt,
    match.date,
    match.startsAt,
    match.fixture?.date,
    match.fixture?.timestamp ? match.fixture.timestamp * 1000 : null,
  ].filter(Boolean);
  if (!candidates.length) return null;
  const t = typeof candidates[0] === 'number'
    ? candidates[0]
    : new Date(candidates[0]).getTime();
  return Number.isFinite(t) ? t : null;
}

function getStatus(match) {
  return match?.status
      || match?.fixture?.status?.short
      || match?.statusShort
      || null;
}

/**
 * Resultado do check:
 *   { ok: boolean, reason: string, hoursAgo?: number }
 */
function checkMatch(match) {
  if (!match) return { ok: false, reason: 'match vazio' };

  const status = getStatus(match);

  // 1) Status finalizado: SEMPRE rejeita
  if (isFinishedStatus(status)) {
    return { ok: false, reason: `status finalizado: ${status}` };
  }

  // 2) Status ao vivo: SEMPRE aceita (independe de timestamp)
  if (isLiveStatus(status)) {
    return { ok: true, reason: `status live: ${status}` };
  }

  // 3) DEMO sem status: usa flag isLive + minuto
  if (match.isLive === true && Number.isFinite(match.minute) && match.minute >= 1 && match.minute <= 95) {
    return { ok: true, reason: `demo live (min ${match.minute})` };
  }
  if (match.isLive === false) {
    return { ok: false, reason: 'isLive=false (demo finalizado)' };
  }

  // 4) Janela temporal por timestamp
  const t = getMatchTimestamp(match);
  if (t == null) {
    // Sem nada para validar → permitir (não temos como afirmar antigo).
    // Caller pode reforçar exigindo timestamp obrigatório.
    return { ok: true, reason: 'sem timestamp (assumido válido)' };
  }
  const hoursAgo = (Date.now() - t) / 3_600_000;
  if (hoursAgo > PAST_HOURS_LIMIT) {
    return { ok: false, reason: `iniciou há ${hoursAgo.toFixed(1)}h (limite ${PAST_HOURS_LIMIT}h)`, hoursAgo };
  }
  if (hoursAgo < -FUTURE_HOURS_LIMIT) {
    return { ok: false, reason: `começa em ${Math.abs(hoursAgo).toFixed(1)}h (limite ${FUTURE_HOURS_LIMIT}h)`, hoursAgo };
  }
  return { ok: true, reason: 'janela ok', hoursAgo };
}

function isRecentMatch(match) {
  return checkMatch(match).ok;
}

/**
 * Pre-live: aceita SOMENTE hoje + próximas FUTURE_HOURS horas.
 * Rejeita qualquer fixture do passado.
 */
function isUpcomingMatch(fixture) {
  if (!fixture) return false;
  const status = getStatus(fixture);
  if (isFinishedStatus(status)) return false;
  if (isLiveStatus(status))     return true; // já começou — ainda válido p/ análise pré-jogo tardia
  const t = getMatchTimestamp(fixture);
  if (t == null) return false; // pré-live SEM data não vale
  const hoursFromNow = (t - Date.now()) / 3_600_000;
  // Aceita: começou há ≤ 30min até começar em FUTURE_HOURS horas
  return hoursFromNow >= -0.5 && hoursFromNow <= FUTURE_HOURS_LIMIT;
}

/**
 * Filter helper para arrays. Recebe array de matches e callback de log opcional.
 */
function filterRecent(matches, onReject) {
  const out = [];
  for (const m of matches || []) {
    const r = checkMatch(m);
    if (r.ok) out.push(m);
    else if (typeof onReject === 'function') onReject(m, r.reason);
  }
  return out;
}

function filterUpcoming(fixtures, onReject) {
  const out = [];
  for (const f of fixtures || []) {
    if (isUpcomingMatch(f)) out.push(f);
    else if (typeof onReject === 'function') onReject(f, 'não está em janela pré-live válida');
  }
  return out;
}

/* ============================================================
   STRICT MODE — só aceita jogos REAIS confirmados pela API.
   Bloqueia:
     - IDs sintéticos (demo-*, pre-*, test-*, mock-*)
     - Matches sem timestamp
     - Matches sem status real (LIVE_STATUSES)
     - Flags isLive sem status confirmado
   ============================================================ */
const SYNTHETIC_ID_PREFIXES = ['demo-', 'pre-', 'test-', 'mock-', 'fake-', 'sample-'];

function isSyntheticId(id) {
  if (id == null) return true;
  const s = String(id).toLowerCase();
  return SYNTHETIC_ID_PREFIXES.some((p) => s.startsWith(p));
}

function checkMatchStrict(match) {
  if (!match) return { ok: false, reason: 'match vazio' };

  if (isSyntheticId(match.id)) {
    return { ok: false, reason: `ID sintético/sem API: ${match.id}` };
  }

  const status = getStatus(match);
  if (!status) {
    return { ok: false, reason: 'sem status confirmado pela API' };
  }
  if (isFinishedStatus(status)) {
    return { ok: false, reason: `status finalizado: ${status}` };
  }
  if (!isLiveStatus(status)) {
    return { ok: false, reason: `status não-live: ${status}` };
  }

  const t = getMatchTimestamp(match);
  if (t == null) {
    return { ok: false, reason: 'sem timestamp real (kickoffAt/date/fixture.date)' };
  }
  const hoursAgo = (Date.now() - t) / 3_600_000;
  if (hoursAgo > PAST_HOURS_LIMIT) {
    return { ok: false, reason: `iniciou há ${hoursAgo.toFixed(1)}h (limite ${PAST_HOURS_LIMIT}h)`, hoursAgo };
  }
  if (hoursAgo < -FUTURE_HOURS_LIMIT) {
    return { ok: false, reason: `começa em ${Math.abs(hoursAgo).toFixed(1)}h (limite ${FUTURE_HOURS_LIMIT}h)`, hoursAgo };
  }

  return { ok: true, reason: `live confirmado: ${status}`, hoursAgo };
}

function isUpcomingMatchStrict(fixture) {
  if (!fixture) return { ok: false, reason: 'fixture vazio' };
  if (isSyntheticId(fixture.id)) return { ok: false, reason: `ID sintético: ${fixture.id}` };
  const status = getStatus(fixture);
  if (status && isFinishedStatus(status)) return { ok: false, reason: `status finalizado: ${status}` };
  const t = getMatchTimestamp(fixture);
  if (t == null) return { ok: false, reason: 'sem startsAt/date real' };
  const hoursFromNow = (t - Date.now()) / 3_600_000;
  if (hoursFromNow < -0.5) return { ok: false, reason: `já começou há ${Math.abs(hoursFromNow).toFixed(1)}h` };
  if (hoursFromNow > FUTURE_HOURS_LIMIT) return { ok: false, reason: `começa em ${hoursFromNow.toFixed(1)}h (>${FUTURE_HOURS_LIMIT}h)` };
  return { ok: true, reason: 'janela pré-live ok' };
}

function filterRecentStrict(matches, onReject) {
  const out = [];
  for (const m of matches || []) {
    const r = checkMatchStrict(m);
    if (r.ok) out.push(m);
    else if (typeof onReject === 'function') onReject(m, r.reason);
  }
  return out;
}

function filterUpcomingStrict(fixtures, onReject) {
  const out = [];
  for (const f of fixtures || []) {
    const r = isUpcomingMatchStrict(f);
    if (r.ok) out.push(f);
    else if (typeof onReject === 'function') onReject(f, r.reason);
  }
  return out;
}

/* ============================================================
   SIGNAL SOURCE GUARD — última camada de defesa antes de emitir
   sinal real (Telegram / DB / Socket).
   Bloqueia QUALQUER match sem confirmação ao vivo externa.
   ============================================================ */
const SIGNAL_API_FRESH_MS = Number(process.env.SIGNAL_API_FRESH_MS || 90_000);
const SOURCE_API_PATTERN  = /^api-/i;

function checkSignalSource(match) {
  if (!match) return { ok: false, reason: 'match vazio' };
  if (match.isFromLiveAPI !== true) {
    return { ok: false, reason: `isFromLiveAPI=${match.isFromLiveAPI} (esperado true)` };
  }
  const src = String(match.source || '');
  if (!SOURCE_API_PATTERN.test(src)) {
    return { ok: false, reason: `source inválido: "${src}" (esperado "api-*")` };
  }
  const last = Number(match.lastApiUpdate || 0);
  if (!last) {
    return { ok: false, reason: 'lastApiUpdate ausente' };
  }
  const ageMs = Date.now() - last;
  if (ageMs > SIGNAL_API_FRESH_MS) {
    return { ok: false, reason: `lastApiUpdate há ${(ageMs/1000).toFixed(1)}s (limite ${SIGNAL_API_FRESH_MS/1000}s)` };
  }
  return { ok: true, reason: `source ok (${src}, ${(ageMs/1000).toFixed(1)}s)` };
}

module.exports = {
  isRecentMatch,
  isUpcomingMatch,
  checkMatch,
  filterRecent,
  filterUpcoming,
  isLiveStatus,
  isFinishedStatus,
  getMatchTimestamp,
  getStatus,
  LIVE_STATUSES,
  FINISHED_STATUSES,
  PAST_HOURS_LIMIT,
  FUTURE_HOURS_LIMIT,
  // strict / real-only
  isSyntheticId,
  checkMatchStrict,
  isUpcomingMatchStrict,
  filterRecentStrict,
  filterUpcomingStrict,
  // signal source guard
  checkSignalSource,
  SIGNAL_API_FRESH_MS,
};
