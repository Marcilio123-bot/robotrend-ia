/**
 * Robotrend IA — Integração Telegram v2 PREMIUM
 *
 * Mensagens ultra-premium estilo tipster profissional:
 *  - badges visuais (HOT/WARM/COLD/DANGER)
 *  - risco LOW/MED/HIGH com emoji 🟢🟡🔴
 *  - odd estimada
 *  - separadores modernos
 *  - emojis dinâmicos baseados em pressão/momentum
 */

'use strict';

const freshness = require('./freshness');

let TelegramBot;
try {
  TelegramBot = require('node-telegram-bot-api');
} catch (e) {
  TelegramBot = null;
}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ENABLED = String(process.env.TELEGRAM_ENABLED || 'false').toLowerCase() === 'true';

let bot = null;
if (ENABLED && TOKEN && TelegramBot) {
  try {
    bot = new TelegramBot(TOKEN, { polling: false });
    console.log('[telegram] Bot inicializado.');
  } catch (err) {
    console.error('[telegram] Falha ao inicializar bot:', err.message);
    bot = null;
  }
} else if (!ENABLED) {
  console.log('[telegram] Desabilitado (TELEGRAM_ENABLED=false). Sinais serão apenas logados.');
}

const TOP    = '╭━━━━━━━━━━━━━━━━━━━━━━╮';
const MID    = '┣━━━━━━━━━━━━━━━━━━━━━━┫';
const BOTTOM = '╰━━━━━━━━━━━━━━━━━━━━━━╯';
const SPLIT  = '━━━━━━━━━━━━━━━━━━━━━━';

function bar(value, max = 100, len = 10) {
  const pct = Math.max(0, Math.min(1, value / max));
  const filled = Math.round(pct * len);
  return '▰'.repeat(filled) + '▱'.repeat(len - filled);
}

function classifyEmoji(cls) {
  if (!cls) return '⚡';
  return cls.emoji || '⚡';
}

function formatLiveSignal(s) {
  const cls = classifyEmoji(s.classification);
  const risk = s.risk || { emoji: '🟡', label: 'MÉDIO' };
  const odd = s.odd ? `~${s.odd}` : '—';

  return [
    `${TOP}`,
    `   ${cls} *ROBOTREND IA — SINAL LIVE*`,
    `${BOTTOM}`,
    '',
    `🏆 *${s.home}*  vs  *${s.away}*`,
    s.league ? `🏟️ _${s.league}_` : null,
    `⏱️ Minuto: *${s.minute}'*  |  Placar: *${s.snapshot?.score?.home ?? 0} : ${s.snapshot?.score?.away ?? 0}*`,
    '',
    SPLIT,
    `📊 *ESTATÍSTICAS LIVE*`,
    SPLIT,
    `🚩 Escanteios:        *${s.snapshot.corners}*`,
    `⚡ Ataques perigosos: *${s.snapshot.dangerousAttacks}*`,
    `🎯 Finalizações:      *${s.snapshot.shots}*`,
    s.snapshot.shotsOnTarget !== undefined ? `🎯 No alvo:           *${s.snapshot.shotsOnTarget}*` : null,
    s.snapshot.possession !== undefined ? `🌀 Posse:             *${s.snapshot.possession}%*` : null,
    '',
    SPLIT,
    `🧠 *ANÁLISE IA*`,
    SPLIT,
    `🌡️ Pressão:    ${bar(s.pressure, 100)} ${s.pressure}/100`,
    s.intensity !== undefined
      ? `💥 Intensidade: ${bar(s.intensity, 100)} ${s.intensity}/100`
      : null,
    s.momentum
      ? `📈 Momentum:   *${s.momentum.label}* (${s.momentum.score}/100)`
      : null,
    s.classification ? `🏷️ Status:     ${cls} *${s.classification.label}*` : null,
    '',
    SPLIT,
    `💎 *ENTRADA SUGERIDA*`,
    SPLIT,
    `🎯 *${s.suggestion}*`,
    s.asianLine ? `🔸 _${s.asianLine}_` : null,
    `💰 Odd estimada: *${odd}*`,
    `⚖️ Risco: ${risk.emoji} *${risk.label}*`,
    `📊 Confiança IA: *${s.confidence}%*`,
    '',
    `_🤖 Robotrend IA · ${new Date().toLocaleTimeString('pt-BR')}_`,
  ].filter(Boolean).join('\n');
}

function formatBttsSignal(s) {
  const risk = s.risk || { emoji: '🟡', label: 'MÉDIO' };
  const odd = s.odd ? `~${s.odd}` : '—';

  const homeHistory = (s.homeStats?.history || [])
    .map((h) => (h.btts ? '🟢' : h.over25 ? '🟡' : '⚪'))
    .join(' ');
  const awayHistory = (s.awayStats?.history || [])
    .map((h) => (h.btts ? '🟢' : h.over25 ? '🟡' : '⚪'))
    .join(' ');

  return [
    `${TOP}`,
    `   ✅ *ROBOTREND IA — BTTS PRÉ-LIVE*`,
    `${BOTTOM}`,
    '',
    `🏆 *${s.home}*  vs  *${s.away}*`,
    s.league ? `🏟️ _${s.league}_` : null,
    s.startsAt ? `📅 ${new Date(s.startsAt).toLocaleString('pt-BR')}` : null,
    '',
    SPLIT,
    `📊 *ÚLTIMOS 6 JOGOS*`,
    SPLIT,
    `*${s.home}*`,
    `   Marcou:  ${s.homeStats.scoredCount}/6  ·  BTTS: ${s.homeStats.bttsPct}%  ·  Over 2.5: ${s.homeStats.over25Pct}%`,
    `   ${homeHistory}`,
    '',
    `*${s.away}*`,
    `   Marcou:  ${s.awayStats.scoredCount}/6  ·  BTTS: ${s.awayStats.bttsPct}%  ·  Over 2.5: ${s.awayStats.over25Pct}%`,
    `   ${awayHistory}`,
    '',
    SPLIT,
    `🧠 *ANÁLISE IA*`,
    SPLIT,
    `💪 Índice ofensivo: ${bar(s.offensiveCombined || 0, 100)} ${s.offensiveCombined || 0}/100`,
    s.over25?.combinedAvgGoals ? `⚽ Média combinada gols: *${s.over25.combinedAvgGoals}*` : null,
    s.over25?.verdict ? `🎯 ${s.over25.verdict} — _${s.over25.suggestion}_` : null,
    '',
    SPLIT,
    `💎 *ENTRADA SUGERIDA*`,
    SPLIT,
    `🎯 *${s.suggestion}*`,
    `💰 Odd estimada: *${odd}*`,
    `⚖️ Risco: ${risk.emoji} *${risk.label}*`,
    `📊 Confiança IA: *${s.confidence}%*`,
    '',
    `_🤖 Robotrend IA · ${new Date().toLocaleTimeString('pt-BR')}_`,
  ].filter(Boolean).join('\n');
}

/**
 * Decide se um sinal está em janela válida para envio.
 * Reusa o módulo de freshness para LIVE; para BTTS olha startsAt.
 */
function isFreshSignal(signal) {
  if (!signal) return { ok: false, reason: 'signal vazio' };
  // Pré-live (BTTS): startsAt precisa ser hoje/futuro próximo
  if (signal.market === 'BTTS' && signal.startsAt) {
    return freshness.isUpcomingMatch({ startsAt: signal.startsAt })
      ? { ok: true }
      : { ok: false, reason: 'BTTS fora da janela pré-live' };
  }
  // Live: reconstrói um pseudo-match com pistas do sinal
  const pseudo = {
    minute: signal.minute,
    status: signal.status,
    isLive: signal.isLive !== false,
    kickoffAt: signal.kickoffAt || signal.snapshot?.kickoffAt,
    date: signal.date,
  };
  return freshness.checkMatch(pseudo);
}

async function sendSignal(signal) {
  // GUARD: nunca envia sinal de partida antiga
  const fresh = isFreshSignal(signal);
  if (!fresh.ok) {
    console.warn(`[telegram] bloqueado sinal antigo (${signal?.home} x ${signal?.away}): ${fresh.reason}`);
    return { ok: false, blocked: 'stale', reason: fresh.reason };
  }
  if (signal.stale) {
    console.warn(`[telegram] bloqueado sinal marcado stale (${signal?.home} x ${signal?.away})`);
    return { ok: false, blocked: 'stale', reason: signal.staleReason };
  }

  const text =
    signal.market === 'BTTS' ? formatBttsSignal(signal) : formatLiveSignal(signal);

  if (!bot || !CHAT_ID) {
    console.log('\n[telegram MOCK]\n' + text + '\n');
    return { ok: true, mocked: true, text };
  }

  try {
    const sent = await bot.sendMessage(CHAT_ID, text, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });
    return { ok: true, mocked: false, messageId: sent.message_id, text };
  } catch (err) {
    console.error('[telegram] erro ao enviar mensagem:', err.message);
    return { ok: false, error: err.message, text };
  }
}

module.exports = {
  sendSignal,
  isFreshSignal,
  formatLiveSignal,
  formatBttsSignal,
  isEnabled: () => Boolean(bot),
};
