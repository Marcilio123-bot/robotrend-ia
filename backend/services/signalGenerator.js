/**
 * Robotrend IA — Signal Generator (contínuo, por mercado)
 *
 * Diferença vs. signalsEngine:
 *   - signalsEngine    = REATIVO (escuta eventos, dispara sinais episódicos)
 *   - signalGenerator  = CONTÍNUO (dado o estado atual do jogo, devolve SEMPRE
 *                         o melhor sinal acionável de cada mercado disponível)
 *
 * Roda como função pura dentro de applyEnrichment → anexa em `match.signals`.
 * Frontend exibe SignalCards filtrados por mercado/perfil/confiança.
 *
 * Saída padronizada (array, um item por mercado quando aplicável):
 *   {
 *     market:      'corners' | 'goals' | 'btts' | 'cards',
 *     signal:      'Over 8.5 escanteios',
 *     confidence:  0..100,
 *     risk:        'low' | 'medium' | 'high',
 *     reasoning:   'texto curto explicando a lógica',
 *     projection:  {                       // range estimado para o fim do jogo
 *       corners:    '10–14',
 *       goals:      '2–3',
 *       cards:      '5–7',
 *       bttsPct:    72,
 *       currentTotal, ratePerMin
 *     },
 *     match: { id, home, away, league, minute, score, kickoffAt },
 *     profile:     'conservative' | 'balanced' | 'aggressive',
 *     generatedAt: timestamp,
 *   }
 *
 * Princípios:
 *   - White-box, determinístico.
 *   - Cada mercado SEMPRE produz um sinal se o jogo está enriched (mesmo que
 *     com confiança baixa — frontend filtra). Isso garante "1–3 sinais por jogo".
 *   - Range = base ± dispersão dependente do minuto (quanto menos minutos
 *     faltam, mais estreito o range).
 *   - Profile derivado do risk: low→conservative, medium→balanced, high→aggressive.
 */

'use strict';

function n(v) { return Number.isFinite(Number(v)) ? Number(v) : 0; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function riskFromConf(conf) {
  if (conf >= 75) return 'low';
  if (conf >= 60) return 'medium';
  return 'high';
}
function profileFromRisk(risk) {
  if (risk === 'low')  return 'conservative';
  if (risk === 'high') return 'aggressive';
  return 'balanced';
}
function matchHeader(m) {
  return {
    id: m.id,
    fixtureId: m.fixtureId,
    home: m.home,
    away: m.away,
    league: m.league?.name,
    country: m.league?.country,
    minute: m.minute,
    status: m.status,
    score: m.score,
    kickoffAt: m.kickoffAt,
  };
}

/* ============================================================
   CORNERS
   ============================================================ */
function buildCornersSignal(m) {
  const min = Math.max(1, n(m.minute));
  const remaining = Math.max(0, 95 - min);
  const total = n(m.stats?.corners?.total);
  const rate = total / min;
  const dispersion = 1 - clamp(min / 90, 0, 0.6); // mais cedo = mais ruído

  // Projeção: 70%–130% do ritmo extrapolado
  const baseAdd = rate * remaining;
  const projMin = Math.round(total + baseAdd * (1 - dispersion * 0.4));
  const projMax = Math.round(total + baseAdd * (1 + dispersion * 0.4));
  const proj    = Math.round((projMin + projMax) / 2);

  // Confidence: ritmo + corroboração com pressão + chutes
  const press = n(m.perMinute?.pressureIndex);
  const sotRate = n(m.stats?.shotsOnTarget?.total) / min;
  let conf = 50;
  if (rate >= 0.15) conf += 10;
  if (rate >= 0.22) conf += 10;
  if (rate >= 0.30) conf += 10;
  if (press >= 50) conf += 5;
  if (sotRate >= 0.08) conf += 5;
  // Janela do jogo: meio é mais previsível
  if (min < 20)  conf -= 12;
  if (min > 75)  conf -= 6;
  conf = clamp(Math.round(conf), 35, 92);

  // Target sugerido: 1 abaixo do projetado central (Over X.5 com margem)
  const target = Math.max(proj - 1, Math.max(2, total + 1));
  const risk = riskFromConf(conf);

  return {
    market: 'corners',
    signal: `Over ${target}.5 escanteios`,
    confidence: conf,
    risk,
    reasoning: `${total} escanteios em ${min}′ (${rate.toFixed(2)}/min). Projeção: ${projMin}–${projMax}.`,
    projection: {
      corners: `${projMin}–${projMax}`,
      currentTotal: total,
      ratePerMin: +rate.toFixed(2),
      target,
    },
    match: matchHeader(m),
    profile: profileFromRisk(risk),
    generatedAt: Date.now(),
  };
}

/* ============================================================
   GOALS (Over/Under inteligente)
   ============================================================ */
function buildGoalsSignal(m) {
  const min = Math.max(1, n(m.minute));
  const remaining = Math.max(0, 95 - min);
  const goals = n(m.score?.home) + n(m.score?.away);
  const sot = n(m.stats?.shotsOnTarget?.total);
  const dang = n(m.stats?.dangerousAttacks?.total);
  const press = n(m.perMinute?.pressureIndex);

  // Ritmo real + ritmo esperado por chutes (taxa de conversão ~22%)
  const rateReal     = goals / min;
  const rateExpected = (sot / min) * 0.22 + (dang / min) * 0.006;
  const rate = rateReal * 0.55 + rateExpected * 0.45;

  const baseAdd = rate * remaining;
  const dispersion = 1 - clamp(min / 90, 0, 0.6);
  const projMinRaw = goals + baseAdd * (1 - dispersion * 0.5);
  const projMaxRaw = goals + baseAdd * (1 + dispersion * 0.5);
  const projMin = Math.max(goals, Math.round(projMinRaw));
  const projMax = Math.max(projMin, Math.round(projMaxRaw));
  const projCenter = (projMinRaw + projMaxRaw) / 2;

  // Decide OVER ou UNDER
  let direction, target, reasoning;
  if (projCenter >= goals + 1.4) {
    // OVER
    direction = 'over';
    target = goals + 1.5;
    reasoning = `Ritmo ofensivo: ${sot} no alvo + pressão ${Math.round(press)}. Projetado ${projMinRaw.toFixed(1)}–${projMaxRaw.toFixed(1)}.`;
  } else if (min >= 30 && projCenter < goals + 0.8) {
    // UNDER
    direction = 'under';
    target = Math.max(goals + 1.5, 2.5);
    reasoning = `Equilíbrio defensivo: ${goals} gol${goals !== 1 ? 's' : ''} em ${min}′, ritmo ${rate.toFixed(3)}/min. Tendência Under.`;
  } else {
    // Sem direção clara → sinal cauteloso de OVER N+0.5 com baixa confiança
    direction = 'over';
    target = goals + 0.5;
    reasoning = `Cenário equilibrado em ${min}′. Sinal cauteloso baseado em projeção central ${projCenter.toFixed(1)}.`;
  }

  // Confidence
  let conf = 50;
  if (direction === 'over') {
    if (projCenter - target >= 0.5)  conf += 12;
    if (projCenter - target >= 1.0)  conf += 8;
    if (sot >= 5) conf += 5;
    if (press >= 50) conf += 5;
  } else {
    if (goals + 1.5 - projCenter >= 0.5) conf += 12;
    if (rate < 0.025) conf += 8;
    if (n(m.stats?.possession?.home) >= 45 && n(m.stats?.possession?.home) <= 55) conf += 4;
  }
  if (min < 25) conf -= 12;
  if (min > 80) conf -= 6;
  conf = clamp(Math.round(conf), 35, 92);

  const risk = riskFromConf(conf);

  return {
    market: 'goals',
    signal: `${direction === 'over' ? 'Over' : 'Under'} ${target} gols`,
    confidence: conf,
    risk,
    reasoning,
    projection: {
      goals: `${projMin}–${projMax}`,
      currentTotal: goals,
      ratePerMin: +rate.toFixed(3),
      direction,
      target,
    },
    match: matchHeader(m),
    profile: profileFromRisk(risk),
    generatedAt: Date.now(),
  };
}

/* ============================================================
   BTTS (Both Teams To Score)
   ============================================================ */
function buildBttsSignal(m) {
  const min = Math.max(1, n(m.minute));
  const sh = n(m.score?.home), sa = n(m.score?.away);

  // Caso já resolvido → sinal "fechado"
  if (sh > 0 && sa > 0) {
    return {
      market: 'btts',
      signal: 'BTTS Sim (já marcou)',
      confidence: 98,
      risk: 'low',
      reasoning: 'Ambas equipes já balançaram a rede — mercado resolvido.',
      projection: { bttsPct: 100, status: 'resolved' },
      match: matchHeader(m),
      profile: 'conservative',
      generatedAt: Date.now(),
    };
  }

  // Caso 0-0 ou 1-0/0-1 → usa likelihood já calculada + pressão do lado que precisa
  const baseLikelihood = clamp(n(m.bttsLikelihood), 0, 100);
  let conf = baseLikelihood * 0.7 + 25; // shift para faixa 25–95
  let direction = 'sim';
  let target = 'BTTS Sim';
  let reasoning;

  if (sh === 0 && sa === 0) {
    // 0×0 — duas variantes possíveis
    if (min >= 60) {
      direction = 'nao';
      target = 'BTTS Não';
      conf = clamp(60 + (min - 60) * 0.6, 60, 88);
      reasoning = `0×0 no ${min}′ — sem ataques perigosos sustentados. Tendência BTTS Não.`;
    } else {
      reasoning = `0×0 ainda — projeção baseada em ${m.stats?.shotsOnTarget?.total ?? 0} chutes no alvo e likelihood ${Math.round(baseLikelihood)}%.`;
    }
  } else {
    // 1-0 ou 0-1 — só falta um time marcar
    const losingSide = sh === 0 ? 'home' : 'away';
    const sotLos = n(m.stats?.shotsOnTarget?.[losingSide]);
    const dangLos = n(m.stats?.dangerousAttacks?.[losingSide]);
    if (sotLos >= 3 && min >= 35) conf += 10;
    if (sotLos >= 5) conf += 8;
    if (dangLos >= 40) conf += 4;
    if (min >= 75 && sotLos < 2) {
      // pouco tempo + lado perdedor sem criar → tende a BTTS Não
      direction = 'nao';
      target = 'BTTS Não';
      conf = clamp(60 + (min - 75) * 2, 60, 88);
      reasoning = `${m[losingSide === 'home' ? 'home' : 'away']} com apenas ${sotLos} no alvo e ${95 - min}′ restantes. Tendência BTTS Não.`;
    } else {
      reasoning = `Lado perdedor (${losingSide === 'home' ? m.home : m.away}) com ${sotLos} no alvo + ${dangLos} ataques perigosos. Likelihood ${Math.round(baseLikelihood)}%.`;
    }
  }
  conf = clamp(Math.round(conf), 35, 92);
  const risk = riskFromConf(conf);

  return {
    market: 'btts',
    signal: target,
    confidence: conf,
    risk,
    reasoning,
    projection: {
      bttsPct: Math.round(direction === 'sim' ? conf : 100 - conf),
      direction,
    },
    match: matchHeader(m),
    profile: profileFromRisk(risk),
    generatedAt: Date.now(),
  };
}

/* ============================================================
   CARDS
   ============================================================ */
function buildCardsSignal(m) {
  const min = Math.max(1, n(m.minute));
  const remaining = Math.max(0, 95 - min);
  const yel = n(m.stats?.cards?.yellow?.total);
  const red = n(m.stats?.cards?.red?.total);
  const totalWeighted = yel + red * 1.5;
  const fouls = n(m.stats?.fouls?.total);
  const rate = totalWeighted / min;
  const rateFouls = fouls / min;

  const dispersion = 1 - clamp(min / 90, 0, 0.6);
  const projMin = Math.max(totalWeighted, Math.round(totalWeighted + rate * remaining * (1 - dispersion * 0.4)));
  const projMax = Math.max(projMin, Math.round(totalWeighted + rate * remaining * (1 + dispersion * 0.4)));
  const proj    = Math.round((projMin + projMax) / 2);

  // Confidence
  let conf = 45;
  if (rate >= 0.05) conf += 10;
  if (rate >= 0.10) conf += 10;
  if (rateFouls >= 0.25) conf += 6;
  if (red >= 1) conf += 8;
  if (min < 25) conf -= 12;
  if (min > 75) conf -= 4;
  conf = clamp(Math.round(conf), 35, 92);

  const target = Math.max(proj - 1, Math.max(2, Math.floor(totalWeighted) + 1));
  const risk = riskFromConf(conf);

  return {
    market: 'cards',
    signal: `Over ${target}.5 cartões`,
    confidence: conf,
    risk,
    reasoning: `${yel} amarelos${red ? ` + ${red} vermelho${red > 1 ? 's' : ''}` : ''} em ${min}′. ${fouls} faltas (${rateFouls.toFixed(2)}/min).`,
    projection: {
      cards: `${projMin}–${projMax}`,
      currentTotal: totalWeighted,
      ratePerMin: +rate.toFixed(2),
      target,
    },
    match: matchHeader(m),
    profile: profileFromRisk(risk),
    generatedAt: Date.now(),
  };
}

/* ============================================================
   PUBLIC API
   ============================================================ */
function generateSignals(match) {
  if (!match) return [];
  // Bloqueios duros: FT/0' nunca produzem sinal, em qualquer modo.
  if (isFinishedStatus(match)) return [];
  if (n(match.minute) === 0) return [];

  const FREE_MODE = String(process.env.FREE_PROVIDER_MODE || 'true').toLowerCase() === 'true';
  const isPartial = !match.enriched || !match.stats || match.dataQuality === 'partial';

  // Provider FREE / dados parciais → usa lógica FREE_PROVIDER_MODE (sem stats)
  if (isPartial) {
    if (!FREE_MODE) return [];
    return generatePartialSignals(match);
  }

  const out = [];
  try { out.push(buildCornersSignal(match)); } catch (_) {}
  try { out.push(buildGoalsSignal(match));   } catch (_) {}
  try { out.push(buildBttsSignal(match));    } catch (_) {}
  try { out.push(buildCardsSignal(match));   } catch (_) {}
  return out.filter(Boolean);
}

/* ============================================================
   FREE PROVIDER MODE
   ------------------------------------------------------------
   Sinais quando o provider só fornece placar + minuto + status
   (TheSportsDB livescore, ScoreBat, etc.). NÃO usamos corners,
   dangerousAttacks, shotsOnTarget, possession aqui.

   Regras (lista oficial):
     OVER 1.5
       - minuto < 70 e gols >= 2 → 70..85 (sobe com gols/atraso)
     OVER 2.5
       - gols >= 2 até 55' → confiança dinâmica
     BTTS Sim
       - ambos marcaram → 90+
     UNDER (1.5/2.5)
       - 0×0 → confiança progressiva pelo minuto

   Bloqueios:
     - status FT/AET/PEN  → []  (nenhum sinal)
     - minute == 0        → []
     - sem projeções absurdas (range cap = max(gols, 1)..gols+2)
   ============================================================ */

/** Status que bloqueiam emissão de sinal. */
const FT_STATUS_RX = /^(FT|AET|PEN|AWD|WO|ABD|CANC|FINISHED|MATCH FINISHED|POSTPONED|PST|SUSP)$/i;
function isFinishedStatus(m) {
  return FT_STATUS_RX.test(String(m?.status || '').toUpperCase().trim())
      || FT_STATUS_RX.test(String(m?.statusLong || '').toUpperCase().trim());
}

function buildOver15FreeSignal(m) {
  const min = n(m.minute);
  const gh = n(m.score?.home), ga = n(m.score?.away);
  const total = gh + ga;
  if (min >= 70 || total < 2) return null;
  // Base 70..85 — cresce com gols extras e quanto mais cedo (mais tempo p/ +1)
  let conf = 70 + (total - 2) * 4 + Math.max(0, 60 - min) * 0.15;
  conf = clamp(Math.round(conf), 70, 85);
  return {
    market: 'goals',
    signal: 'Over 1.5 gols',
    confidence: conf,
    risk: riskFromConf(conf),
    reasoning: `${total} gols aos ${min}′ — Over 1.5 já resolvido se o mercado for live, válido como leitura de ritmo ofensivo.`,
    projection: { goals: `${total}–${Math.min(total + 2, total + 2)}`, currentTotal: total, target: 1.5, direction: 'over', dataQuality: 'partial' },
    match: matchHeader(m),
    profile: profileFromRisk(riskFromConf(conf)),
    dataQuality: 'partial',
    partial: true,
    generatedAt: Date.now(),
  };
}

function buildOver25FreeSignal(m) {
  const min = n(m.minute);
  const gh = n(m.score?.home), ga = n(m.score?.away);
  const total = gh + ga;
  if (min > 55 || total < 2) return null;
  // Quanto antes 2+ gols, mais alta a confiança (Poisson-ish heurístico)
  const earliness = clamp(1 - min / 55, 0, 1);  // 1.0 aos 0', 0.0 aos 55'
  let conf = 60 + earliness * 25 + (total - 2) * 4;
  conf = clamp(Math.round(conf), 60, 88);
  return {
    market: 'goals',
    signal: 'Over 2.5 gols',
    confidence: conf,
    risk: riskFromConf(conf),
    reasoning: `${total} gols já em apenas ${min}′ — ritmo elevado favorece Over 2.5.`,
    projection: { goals: `${total}–${Math.max(total + 1, total + 2)}`, currentTotal: total, target: 2.5, direction: 'over', dataQuality: 'partial' },
    match: matchHeader(m),
    profile: profileFromRisk(riskFromConf(conf)),
    dataQuality: 'partial',
    partial: true,
    generatedAt: Date.now(),
  };
}

function buildBttsFreeSignal(m) {
  const gh = n(m.score?.home), ga = n(m.score?.away);
  if (gh === 0 || ga === 0) return null;
  // Ambos já marcaram → mercado resolvido. 90+ por design.
  return {
    market: 'btts',
    signal: 'BTTS Sim',
    confidence: 95,
    risk: 'low',
    reasoning: `Ambos marcaram (${gh}×${ga}) — BTTS resolvido.`,
    projection: { bttsPct: 100, direction: 'sim', status: 'resolved', dataQuality: 'partial' },
    match: matchHeader(m),
    profile: 'conservative',
    dataQuality: 'partial',
    partial: true,
    generatedAt: Date.now(),
  };
}

function buildUnderFreeSignal(m) {
  const min = n(m.minute);
  const gh = n(m.score?.home), ga = n(m.score?.away);
  const total = gh + ga;
  if (total > 0 || min < 60) return null;
  // 0×0 até 60'+ — Under 1.5 progressivo. Aos 60' começa em 60%; sobe ~1pt/min.
  let conf = 60 + (min - 60) * 1.2;
  if (min >= 75) conf += 5;
  conf = clamp(Math.round(conf), 60, 92);
  const target = min >= 75 ? 1.5 : 2.5;
  return {
    market: 'goals',
    signal: `Under ${target} gols`,
    confidence: conf,
    risk: riskFromConf(conf),
    reasoning: `0×0 aos ${min}′ — Tendência de Under (${95 - min}′ restantes).`,
    projection: { goals: `0–1`, currentTotal: 0, target, direction: 'under', dataQuality: 'partial' },
    match: matchHeader(m),
    profile: profileFromRisk(riskFromConf(conf)),
    dataQuality: 'partial',
    partial: true,
    generatedAt: Date.now(),
  };
}

/**
 * Sinais parciais (FREE provider mode). Usa apenas placar/minuto/status.
 *
 * NÃO depende de stats avançadas (corners, dangerousAttacks, shotsOnTarget,
 * possession). Bloqueia FT/0'. Garante UI acionável quando o pipeline
 * está rodando com TheSportsDB ou outro provider gratuito.
 */
function generatePartialSignals(match) {
  if (!match) return [];
  // Bloqueios de segurança
  if (isFinishedStatus(match)) return [];
  if (n(match.minute) === 0) return [];

  const out = [];
  const tryAdd = (fn) => { try { const s = fn(match); if (s) out.push(s); } catch (_) {} };
  tryAdd(buildOver15FreeSignal);
  tryAdd(buildOver25FreeSignal);
  tryAdd(buildBttsFreeSignal);
  tryAdd(buildUnderFreeSignal);
  return out;
}

/**
 * Filtra signals por prefs do usuário (markets/profile/minConfidence).
 * Reaproveita semântica de matchInsights.filterPicksByPrefs.
 */
function filterSignalsByPrefs(signals, prefs = {}) {
  if (!Array.isArray(signals) || !signals.length) return signals;
  let out = signals.slice();
  if (Array.isArray(prefs.markets) && prefs.markets.length) {
    out = out.filter((s) => prefs.markets.includes(s.market));
  }
  if (prefs.minConfidence) out = out.filter((s) => s.confidence >= prefs.minConfidence);
  if (prefs.profile && prefs.profile !== 'balanced') {
    out = out.filter((s) => s.profile === prefs.profile || s.profile === 'balanced');
  }
  return out;
}

module.exports = {
  generateSignals,
  generatePartialSignals,
  filterSignalsByPrefs,
  _internals: { buildCornersSignal, buildGoalsSignal, buildBttsSignal, buildCardsSignal },
};
