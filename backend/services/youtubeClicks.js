/**
 * Robotrend IA — Contador global de cliques YouTube (?src=youtube)
 *
 * Apenas um número total, sem IP, data ou dados pessoais.
 * Persistência em data/youtube-clicks.json (sobrevive a restart).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PERSIST_PATH = path.join(process.cwd(), 'data', 'youtube-clicks.json');

let total = 0;
let loaded = false;

function ensureDataDir() {
  const dir = path.dirname(PERSIST_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function load() {
  if (loaded) return;
  loaded = true;
  try {
    if (!fs.existsSync(PERSIST_PATH)) {
      total = 0;
      return;
    }
    const raw = fs.readFileSync(PERSIST_PATH, 'utf8');
    const data = JSON.parse(raw);
    total = Math.max(0, Number(data?.total) || 0);
  } catch {
    total = 0;
  }
}

function persist() {
  try {
    ensureDataDir();
    fs.writeFileSync(PERSIST_PATH, JSON.stringify({ total }, null, 0), 'utf8');
  } catch {
    /* best-effort — não quebra o request */
  }
}

/** Incrementa +1 quando a URL contém ?src=youtube */
function recordClick() {
  load();
  total += 1;
  persist();
}

function getTotal() {
  load();
  return total;
}

/** Middleware Express — registra clique em qualquer rota. */
function trackMiddleware(req, _res, next) {
  try {
    const raw = req.query?.src;
    const hit = Array.isArray(raw)
      ? raw.some((v) => String(v).toLowerCase() === 'youtube')
      : String(raw || '').toLowerCase() === 'youtube';
    if (hit) recordClick();
  } catch {
    /* silent */
  }
  next();
}

module.exports = {
  recordClick,
  getTotal,
  trackMiddleware,
};
