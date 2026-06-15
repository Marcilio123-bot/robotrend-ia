/**
 * Robotrend IA — Cota Diária de Sinais do Plano FREE
 * ============================================================================
 *
 * REGRA DE NEGÓCIO:
 *   - Usuários FREE podem VISUALIZAR no máximo N sinais por dia
 *     (N = plano FREE.dailySignals, default 4).
 *   - Ao atingir o limite, os demais sinais do dia são BLOQUEADOS
 *     (substituídos por um placeholder de upgrade).
 *   - O contador reseta automaticamente à meia-noite (HORÁRIO DO SERVIDOR).
 *   - Planos pagos (PREMIUM/SEMESTRAL/ANUAL) e admins NÃO passam por aqui:
 *     o gating é aplicado apenas a usuários FREE em signalAccess.js.
 *
 * MODELO:
 *   Para cada usuário, mantemos o CONJUNTO de identidades de sinais distintos
 *   já "desbloqueados" hoje. Reapresentar o mesmo sinal (re-render, reconexão
 *   de socket, polling REST) NÃO consome cota — só sinais NOVOS contam, até o
 *   limite. Isso garante coerência entre API e interface e evita contagem dupla
 *   quando o mesmo sinal chega por vários canais (REST + socket + broadcast).
 *
 * PERSISTÊNCIA:
 *   Estado em memória (consistente com o restante do pipeline de sinais ao vivo,
 *   que também é in-memory single-instance) + persistência best-effort em
 *   data/free-signal-quota.json para sobreviver a restarts dentro do mesmo dia.
 *   Nunca lança: a telemetria/persistência não pode quebrar a entrega de sinais.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_LIMIT = 4;
const PERSIST_PATH = path.join(process.cwd(), 'data', 'free-signal-quota.json');
const PERSIST_INTERVAL_MS = Number(process.env.FREE_QUOTA_PERSIST_MS || 30_000);

/** Limite diário de sinais do plano FREE (fonte: plans.js, fallback env/4). */
function dailyLimit() {
  const fromEnv = Number(process.env.PLAN_FREE_DAILY_SIGNALS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  try {
    const { getPlan } = require('../plans');
    const n = Number(getPlan('FREE')?.dailySignals);
    if (Number.isFinite(n) && n > 0) return n;
  } catch (_) { /* plans indisponível no boot — usa default */ }
  return DEFAULT_LIMIT;
}

/**
 * Chave do dia no HORÁRIO DO SERVIDOR (não UTC) — garante reset à meia-noite
 * local do servidor, como pedido pela regra de negócio.
 */
function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const state = {
  day: dayKey(),
  users: new Map(), // userId(string) -> Set<signalKey>
};

let _loaded = false;
let _lastPersistAt = 0;

/** Garante que o estado pertence ao dia corrente; vira o contador na meia-noite. */
function rollover() {
  const today = dayKey();
  if (state.day !== today) {
    state.day = today;
    state.users.clear();
    persist(true);
  }
}

/** Identidade estável de um sinal (id explícito ou composto match+mercado+hora). */
function signalKey(signal) {
  if (!signal) return '';
  if (signal.id != null && signal.id !== '') return `id:${signal.id}`;
  const match = signal.matchId ?? signal.match?.id ?? signal.fixtureId ?? '';
  const market = signal.market ?? signal.type ?? '';
  const created = signal.createdAt ?? signal.created_at ?? '';
  return `${match}|${market}|${created}`;
}

function bucket(userId) {
  const key = String(userId);
  let set = state.users.get(key);
  if (!set) { set = new Set(); state.users.set(key, set); }
  return set;
}

/** Quantidade de sinais distintos já consumidos hoje pelo usuário. */
function usedCount(userId) {
  if (userId == null) return 0;
  rollover();
  return state.users.get(String(userId))?.size || 0;
}

/** Snapshot do contador para a UI/API: { used, limit, remaining, day }. */
function snapshot(userId) {
  const limit = dailyLimit();
  const used = usedCount(userId);
  return {
    used: Math.min(used, limit),
    limit,
    remaining: Math.max(0, limit - used),
    day: state.day,
  };
}

/**
 * Tenta liberar um sinal para o usuário FREE.
 *   - true  → pode ver (já estava desbloqueado OU havia cota; consome se novo)
 *   - false → limite diário atingido (deve ser bloqueado)
 */
function tryConsume(userId, signal) {
  if (userId == null) return true; // sem identidade → não há como rastrear; não bloqueia
  if (!_loaded) load();
  rollover();
  const key = signalKey(signal);
  if (!key) return true;
  const set = bucket(userId);
  if (set.has(key)) return true;       // já contava — reapresentação
  if (set.size >= dailyLimit()) return false; // estourou a cota
  set.add(key);
  _maybePersist();
  return true;
}

/** Reset manual da cota de um usuário (uso administrativo/testes). */
function reset(userId) {
  if (userId == null) { state.users.clear(); return; }
  state.users.delete(String(userId));
}

/* ============================================================
   PERSISTÊNCIA (best-effort)
   ============================================================ */
function _maybePersist() {
  const now = Date.now();
  if (now - _lastPersistAt < PERSIST_INTERVAL_MS) return;
  persist();
}

function persist(force = false) {
  if (!force) _lastPersistAt = Date.now();
  try {
    fs.mkdirSync(path.dirname(PERSIST_PATH), { recursive: true });
    const users = {};
    for (const [uid, set] of state.users) users[uid] = Array.from(set);
    fs.writeFileSync(PERSIST_PATH, JSON.stringify({ day: state.day, users, savedAt: Date.now() }));
    _lastPersistAt = Date.now();
  } catch (_) { /* persistência nunca quebra o pipeline */ }
}

function load() {
  _loaded = true;
  try {
    if (!fs.existsSync(PERSIST_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(PERSIST_PATH, 'utf8'));
    // Só restaura se for do MESMO dia — caso contrário começa zerado (reset diário).
    if (raw && raw.day === dayKey() && raw.users && typeof raw.users === 'object') {
      state.day = raw.day;
      for (const [uid, keys] of Object.entries(raw.users)) {
        if (Array.isArray(keys)) state.users.set(uid, new Set(keys));
      }
    }
  } catch (_) { /* arquivo corrompido/ausente — começa zerado */ }
}

module.exports = {
  dailyLimit,
  dayKey,
  signalKey,
  usedCount,
  snapshot,
  tryConsume,
  reset,
  persist,
  load,
};
