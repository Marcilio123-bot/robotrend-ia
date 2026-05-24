/**
 * Robotrend IA — Brute Force Protection
 *
 *   Estratégia:
 *     - Conta tentativas falhas por email + por IP
 *     - Bloqueia exponencialmente (5 falhas → 1min · 10 → 5min · 20 → 1h)
 *     - Limpa contadores após sucesso ou expiração
 */

'use strict';

const attempts = new Map(); // key -> { fails, blockedUntil }
const MAX_ENTRIES = 5000;

function getEntry(key) {
  let e = attempts.get(key);
  if (!e) { e = { fails: 0, blockedUntil: 0 }; attempts.set(key, e); }
  return e;
}

function isBlocked(key) {
  const e = attempts.get(key);
  if (!e) return false;
  if (e.blockedUntil > Date.now()) return true;
  return false;
}

function recordFail(key) {
  const e = getEntry(key);
  e.fails++;
  if (e.fails >= 20)      e.blockedUntil = Date.now() + 60 * 60 * 1000;     // 1h
  else if (e.fails >= 10) e.blockedUntil = Date.now() + 5  * 60 * 1000;     // 5min
  else if (e.fails >= 5)  e.blockedUntil = Date.now() + 1  * 60 * 1000;     // 1min
  // janitor leve
  if (attempts.size > MAX_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of attempts) {
      if (v.blockedUntil < now && v.fails < 3) attempts.delete(k);
      if (attempts.size <= MAX_ENTRIES) break;
    }
  }
  return e;
}

function recordSuccess(key) {
  attempts.delete(key);
}

function status(key) {
  const e = attempts.get(key);
  if (!e) return { fails: 0, blocked: false };
  return {
    fails: e.fails,
    blocked: e.blockedUntil > Date.now(),
    secondsRemaining: Math.max(0, Math.round((e.blockedUntil - Date.now()) / 1000)),
  };
}

/**
 * Wrap em login: chame antes/depois de verificar senha.
 *   const k = `${email}:${ip}`;
 *   if (bruteforce.isBlocked(k)) return res.status(429).json({...});
 *   ...
 *   if (passwordWrong) bruteforce.recordFail(k);
 *   else bruteforce.recordSuccess(k);
 */
module.exports = { isBlocked, recordFail, recordSuccess, status };
