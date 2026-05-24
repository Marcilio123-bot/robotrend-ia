/**
 * Robotrend IA — Football Alerts Engine
 *
 * Subscreve eventos do EventBus e dispara alertas Telegram quando
 * thresholds configuráveis são atingidos.
 *
 * Anti-spam:
 *   - cada (matchId × tipo) tem cooldown (ALERT_COOLDOWN_MS, default 4min)
 *   - cada alerta global tem cooldown (quota:low etc)
 *
 * Tipos de alerta:
 *   - goal           (sempre — placar mudou)
 *   - corner-spike   (>= CORNER_SPIKE em ≤ CORNER_WINDOW_MIN minutos)
 *   - pressure-surge (delta de pressão > PRESSURE_DELTA com pressure final >= PRESSURE_MIN)
 *   - btts-near      (BTTS prestes a acontecer)
 *   - red-card       (vermelho expulsa o jogo)
 *   - quota-low      (cota da API <= QUOTA_LOW_PCT)
 *   - circuit-open   (API-Sports indisponível há vários ciclos)
 *
 * Tudo configurável via .env. Em produção, manda via Telegram. Em dev
 * (ou se TELEGRAM_ENABLED=false), só loga.
 */

'use strict';

const events = require('./footballEvents');
const telegram = require('../telegram');
const { logger } = require('../logger');

const log = logger.child({ module: 'footballAlerts' });

const ENABLED              = String(process.env.FOOTBALL_ALERTS_ENABLED || 'true').toLowerCase() !== 'false';
const ALERT_COOLDOWN_MS    = Number(process.env.FOOTBALL_ALERT_COOLDOWN_MS || 4 * 60_000);
const GLOBAL_COOLDOWN_MS   = Number(process.env.FOOTBALL_GLOBAL_ALERT_COOLDOWN_MS || 30 * 60_000);

const PRESSURE_DELTA       = Number(process.env.FOOTBALL_ALERT_PRESSURE_DELTA || 18);
const PRESSURE_MIN         = Number(process.env.FOOTBALL_ALERT_PRESSURE_MIN || 65);
const CORNER_SPIKE         = Number(process.env.FOOTBALL_ALERT_CORNER_SPIKE || 3);
const CORNER_WINDOW_MIN    = Number(process.env.FOOTBALL_ALERT_CORNER_WINDOW_MIN || 5);
const BTTS_NEAR_ENABLED    = String(process.env.FOOTBALL_ALERT_BTTS_NEAR || 'true').toLowerCase() !== 'false';

const cooldowns = new Map(); // key -> timestamp
const cornerLog = new Map(); // matchId -> [{ minute, ts }]
const globalCooldowns = new Map();

function canFire(key, cooldownMs = ALERT_COOLDOWN_MS) {
  const now = Date.now();
  const last = cooldowns.get(key) || 0;
  if (now - last < cooldownMs) return false;
  cooldowns.set(key, now);
  return true;
}
function canFireGlobal(key, cooldownMs = GLOBAL_COOLDOWN_MS) {
  const now = Date.now();
  const last = globalCooldowns.get(key) || 0;
  if (now - last < cooldownMs) return false;
  globalCooldowns.set(key, now);
  return true;
}

function bar(value, max = 100, len = 10) {
  const pct = Math.max(0, Math.min(1, value / max));
  const filled = Math.round(pct * len);
  return '▰'.repeat(filled) + '▱'.repeat(len - filled);
}

function fmtMatch(m) {
  return `*${m.home}* ${m.score?.home ?? 0} - ${m.score?.away ?? 0} *${m.away}*  _(${m.minute}')_`;
}

async function dispatch(text, kind) {
  log.info('alert', { kind, preview: text.split('\n')[0].slice(0, 80) });
  try {
    // Reusa o `telegram` existente, mas envia mensagem livre (não signal)
    // Pseudo-signal com market só para diferenciar:
    const fakeSignal = {
      __isAlert: true,
      market: '__alert',
      text,
      createdAt: new Date().toISOString(),
    };
    // Mandamos via bot direto se disponível; senão fica no log
    if (!telegram.isEnabled()) {
      console.log('\n[footballAlerts MOCK]\n' + text + '\n');
      return { ok: true, mocked: true };
    }
    // Usa a API privada: pegamos a referência do bot reusando sendSignal?
    // sendSignal valida freshness; vamos chamar bot.sendMessage direto.
    // Como o módulo telegram não expõe o bot, usamos um truque: monta um
    // sendSignal stub. Para alertas independentes, expomos sendRawTelegram
    // se existir, senão usamos fakeSignal pelo sendSignal (que vai falhar
    // freshness para `__alert`). Simples: vamos exportar sendRaw aqui:
    return await sendRawTelegram(text);
  } catch (e) {
    log.warn('alert dispatch failed', { err: e.message });
    return { ok: false, error: e.message };
  }
}

/**
 * Envia mensagem livre via Telegram. Tenta usar TelegramBot direto;
 * cai para MOCK no console se algo falhar (ex.: bot não configurado).
 */
let _bot = null;
function getBot() {
  if (_bot !== null) return _bot;
  try {
    const TelegramBot = require('node-telegram-bot-api');
    const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const ENABLED_TG = String(process.env.TELEGRAM_ENABLED || 'false').toLowerCase() === 'true';
    if (!TOKEN || !ENABLED_TG) { _bot = false; return _bot; }
    _bot = new TelegramBot(TOKEN, { polling: false });
    return _bot;
  } catch { _bot = false; return _bot; }
}

async function sendRawTelegram(text) {
  const bot = getBot();
  const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
  if (!bot || !CHAT_ID) {
    console.log('\n[footballAlerts MOCK]\n' + text + '\n');
    return { ok: true, mocked: true };
  }
  try {
    const sent = await bot.sendMessage(CHAT_ID, text, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });
    return { ok: true, messageId: sent.message_id };
  } catch (e) {
    log.warn('telegram error', { err: e.message });
    return { ok: false, error: e.message };
  }
}

/* ============================================================
   HANDLERS
   ============================================================ */
function onGoal({ match, side }) {
  if (!canFire(`goal:${match.id}:${match.score.home}-${match.score.away}`)) return;
  const text = [
    `⚽ *GOOOL!*`,
    fmtMatch(match),
    `🏟️ _${match.league?.name || ''}_`,
    side === 'home' ? `🟢 *${match.home}* marcou` : `🟡 *${match.away}* marcou`,
    ``,
    `_🤖 Robotrend · ${new Date().toLocaleTimeString('pt-BR')}_`,
  ].join('\n');
  dispatch(text, 'goal');
}

function onCorner({ match }) {
  const id = String(match.id);
  const now = Date.now();
  const list = cornerLog.get(id) || [];
  list.push({ minute: match.minute, ts: now });
  // mantém só os últimos da janela
  const windowMs = CORNER_WINDOW_MIN * 60_000;
  while (list.length && now - list[0].ts > windowMs) list.shift();
  cornerLog.set(id, list);

  if (list.length >= CORNER_SPIKE) {
    if (!canFire(`corner-spike:${id}`)) return;
    const text = [
      `🚩 *SURTO DE ESCANTEIOS*`,
      fmtMatch(match),
      `${list.length} escanteios em ${CORNER_WINDOW_MIN}min — *${match.stats?.corners?.total} total*`,
      `Pressão atual: ${bar(match.perMinute?.pressureIndex || 0, 100)} ${match.perMinute?.pressureIndex || 0}`,
      ``,
      `_🤖 Robotrend · ${new Date().toLocaleTimeString('pt-BR')}_`,
    ].join('\n');
    dispatch(text, 'corner-spike');
  }
}

function onCard({ match, color }) {
  if (color !== 'red') return; // só vermelho dispara alerta default
  if (!canFire(`red-card:${match.id}`)) return;
  const text = [
    `🟥 *CARTÃO VERMELHO*`,
    fmtMatch(match),
    `🏟️ _${match.league?.name || ''}_`,
    `Total vermelhos: *${match.stats?.cards?.red?.total || 0}*`,
    ``,
    `_🤖 Robotrend · ${new Date().toLocaleTimeString('pt-BR')}_`,
  ].join('\n');
  dispatch(text, 'red-card');
}

function onPressure({ match, pressure, delta }) {
  if (delta < PRESSURE_DELTA || pressure < PRESSURE_MIN) return;
  if (!canFire(`pressure:${match.id}`)) return;
  const text = [
    `🔥 *PRESSÃO OFENSIVA EM ALTA*`,
    fmtMatch(match),
    `🏟️ _${match.league?.name || ''}_`,
    `Pressão: ${bar(pressure, 100)} *${pressure}* (Δ +${delta.toFixed(1)})`,
    `Chutes: ${match.stats?.shots?.total || 0} · No alvo: ${match.stats?.shotsOnTarget?.total || 0}`,
    `Escanteios: ${match.stats?.corners?.total || 0}`,
    ``,
    `_🤖 Robotrend · ${new Date().toLocaleTimeString('pt-BR')}_`,
  ].join('\n');
  dispatch(text, 'pressure-surge');
}

function onBttsNear({ match, reason }) {
  if (!BTTS_NEAR_ENABLED) return;
  if (!canFire(`btts-near:${match.id}`)) return;
  const text = [
    `🎯 *BTTS IMINENTE*`,
    fmtMatch(match),
    `🏟️ _${match.league?.name || ''}_`,
    `Motivo: _${reason}_`,
    `Chutes no alvo (que está perdendo): foco em finalizações precisas`,
    ``,
    `_🤖 Robotrend · ${new Date().toLocaleTimeString('pt-BR')}_`,
  ].join('\n');
  dispatch(text, 'btts-near');
}

function onQuotaLow({ remaining, limit, ratio }) {
  if (!canFireGlobal('quota-low')) return;
  const pct = Math.round(ratio * 100);
  const text = [
    `⚠️ *QUOTA API-SPORTS BAIXA*`,
    `Restante: *${remaining}* / ${limit} (${pct}%)`,
    `Considere subir o plano ou reduzir polling.`,
    ``,
    `_🤖 Robotrend · ${new Date().toLocaleTimeString('pt-BR')}_`,
  ].join('\n');
  dispatch(text, 'quota-low');
}

function onCircuitOpen({ name, lastError }) {
  if (!canFireGlobal('circuit-open')) return;
  const text = [
    `🛑 *CIRCUITO ABERTO — ${name}*`,
    `Último erro: \`${lastError || 'unknown'}\``,
    `Servindo de stale-cache enquanto se recupera.`,
    ``,
    `_🤖 Robotrend · ${new Date().toLocaleTimeString('pt-BR')}_`,
  ].join('\n');
  dispatch(text, 'circuit-open');
}

function onCircuitClose({ name }) {
  // sempre dispara — é boa notícia, não dá spam (1× por incident)
  const text = [
    `✅ *CIRCUITO RESTAURADO — ${name}*`,
    `API-Sports voltou ao normal.`,
    ``,
    `_🤖 Robotrend · ${new Date().toLocaleTimeString('pt-BR')}_`,
  ].join('\n');
  dispatch(text, 'circuit-close');
}

/* ============================================================
   START / STOP
   ============================================================ */
let started = false;

function start() {
  if (!ENABLED) {
    log.warn('football alerts desabilitados (FOOTBALL_ALERTS_ENABLED=false)');
    return;
  }
  if (started) return;
  started = true;
  events.on('fixture:goal',      onGoal);
  events.on('fixture:corner',    onCorner);
  events.on('fixture:card',      onCard);
  events.on('fixture:pressure',  onPressure);
  events.on('fixture:btts-near', onBttsNear);
  events.on('quota:low',         onQuotaLow);
  events.on('circuit:open',      onCircuitOpen);
  events.on('circuit:close',     onCircuitClose);
  log.info('football alerts engine ativo', {
    pressureDelta: PRESSURE_DELTA,
    pressureMin: PRESSURE_MIN,
    cornerSpike: CORNER_SPIKE,
    cornerWindowMin: CORNER_WINDOW_MIN,
    bttsNear: BTTS_NEAR_ENABLED,
  });
}

function stop() {
  if (!started) return;
  events.off('fixture:goal',      onGoal);
  events.off('fixture:corner',    onCorner);
  events.off('fixture:card',      onCard);
  events.off('fixture:pressure',  onPressure);
  events.off('fixture:btts-near', onBttsNear);
  events.off('quota:low',         onQuotaLow);
  events.off('circuit:open',      onCircuitOpen);
  events.off('circuit:close',     onCircuitClose);
  started = false;
}

function snapshot() {
  return {
    enabled: ENABLED,
    started,
    pressureDelta: PRESSURE_DELTA,
    pressureMin: PRESSURE_MIN,
    cornerSpike: CORNER_SPIKE,
    cornerWindowMin: CORNER_WINDOW_MIN,
    bttsNear: BTTS_NEAR_ENABLED,
    cooldownMs: ALERT_COOLDOWN_MS,
    activeCooldowns: cooldowns.size,
  };
}

module.exports = { start, stop, snapshot, sendRawTelegram };
