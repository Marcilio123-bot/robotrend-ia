/**
 * Robotrend IA — Match Insights
 *
 * Camada interpretativa SOBRE os dados já existentes.
 *
 * PURE FUNCTION. Sem IO, sem cache, sem chamadas externas, sem timers.
 * Recebe um match enriquecido (após applyEnrichment) e devolve:
 *
 *   {
 *     trends: {
 *       goals:     'low' | 'mid' | 'high',
 *       corners:   'low' | 'mid' | 'high',
 *       intensity: 'weak' | 'balanced' | 'high',
 *       moment:    'control' | 'attack' | 'final-pressure',
 *     },
 *     reads: [ { icon, text } ],         // leitura em linguagem natural
 *     picks: [ { kind, market, label, confidence, risk, reason } ],
 *     summary: 'frase curta resumindo o cenário',
 *     computedAt: timestamp
 *   }
 *
 * Princípios:
 *   - White-box: cada heurística é explicável em 1 linha.
 *   - Resistente a dados ausentes (m.stats=null → null insight).
 *   - Determinístico: a mesma entrada produz a mesma saída.
 *   - Anti-spam: thresholds calibrados para não emitir "alta" em qualquer jogo.
 *
 * Os "picks" são DICAS de leitura, NÃO recomendações financeiras. O frontend
 * deve marcar isso explicitamente.
 */

'use strict';

function n(v) { return Number.isFinite(Number(v)) ? Number(v) : 0; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function pct(v) { return Math.round(v); }

/* ============================================================
   TRENDS
   ============================================================ */
function trendGoals(m) {
  const min = Math.max(1, n(m.minute));
  const goals = n(m.score?.home) + n(m.score?.away);
  const sot   = n(m.stats?.shotsOnTarget?.total);
  const dang  = n(m.stats?.dangerousAttacks?.total);

  // Projeção: gols reais extrapolados + chutes no alvo convertendo a 22%
  // + ataques perigosos contribuindo marginalmente (0.6%).
  const proj = (goals / min) * 90 + (sot / min) * 90 * 0.22 + (dang / min) * 90 * 0.006;
  if (proj >= 3.0) return 'high';
  if (proj >= 1.8) return 'mid';
  return 'low';
}

function trendCorners(m) {
  const min = Math.max(1, n(m.minute));
  const total = n(m.stats?.corners?.total);
  const rate = total / min;            // corners/min
  const proj = rate * 95;              // projeção full-time
  if (proj >= 11) return 'high';
  if (proj >= 7)  return 'mid';
  return 'low';
}

function trendIntensity(m) {
  // Combina ataques + ataques perigosos + chutes em janela atual
  const min = Math.max(1, n(m.minute));
  const attacks = n(m.stats?.attacks?.total);
  const dang    = n(m.stats?.dangerousAttacks?.total);
  const shots   = n(m.stats?.shots?.total);
  const fouls   = n(m.stats?.fouls?.total);

  const intensityIdx = (attacks * 0.05 + dang * 0.15 + shots * 0.6 + fouls * 0.1) / min;
  if (intensityIdx >= 3.5) return 'high';
  if (intensityIdx >= 1.6) return 'balanced';
  return 'weak';
}

function trendMoment(m) {
  const min = n(m.minute);
  const sh = n(m.score?.home), sa = n(m.score?.away);
  const sotH = n(m.stats?.shotsOnTarget?.home);
  const sotA = n(m.stats?.shotsOnTarget?.away);
  const totalSot = sotH + sotA;

  // Pressão final: minuto > 75 e qualquer lado precisando do gol
  if (min >= 75 && (sh === sa || Math.abs(sh - sa) === 1)) return 'final-pressure';

  // Ataque: chutes recentes + posse alta de algum lado
  const possH = n(m.stats?.possession?.home);
  if (totalSot >= 6 && (possH >= 60 || possH <= 40)) return 'attack';

  return 'control';
}

/* ============================================================
   READS — leitura em linguagem natural
   ============================================================ */
function buildReads(m, t) {
  const reads = [];
  const min = n(m.minute);
  const sh = n(m.score?.home), sa = n(m.score?.away);
  const goals = sh + sa;
  const press = n(m.perMinute?.pressureIndex);
  const corners = n(m.stats?.corners?.total);
  const sot = n(m.stats?.shotsOnTarget?.total);

  // Gols
  if (t.goals === 'high') {
    reads.push({
      icon: '⚽',
      text: `Ritmo ofensivo elevado — ${sot} chutes no alvo em ${min}′ sugerem Over 2.5 gols.`,
    });
  } else if (t.goals === 'low' && min >= 35) {
    reads.push({
      icon: '🛡',
      text: `Equilíbrio defensivo prevalecendo — apenas ${goals} gol${goals !== 1 ? 's' : ''} até o ${min}′. Tendência Under.`,
    });
  }

  // Escanteios
  if (t.corners === 'high') {
    reads.push({
      icon: '🚩',
      text: `Padrão de muitos escanteios — ${corners} no ${min}′ projetam ${(corners / Math.max(1, min) * 95).toFixed(0)}+ até o fim.`,
    });
  } else if (t.corners === 'mid' && min < 45) {
    reads.push({
      icon: '🚩',
      text: `Ritmo moderado de escanteios no 1º tempo — mercado de Over no 2º tempo pode aquecer.`,
    });
  }

  // Intensidade / Momento
  if (t.intensity === 'high' && t.moment === 'attack') {
    const side = n(m.stats?.shotsOnTarget?.home) > n(m.stats?.shotsOnTarget?.away)
      ? (m.home || 'mandante') : (m.away || 'visitante');
    reads.push({
      icon: '🔥',
      text: `${side} pressionando — pressão IA ${pct(press)}. Tendência de Over cantos no curto prazo.`,
    });
  } else if (t.intensity === 'weak' && min >= 30) {
    reads.push({
      icon: '😴',
      text: `Jogo travado — baixa intensidade. Mercados de Under podem ser interessantes.`,
    });
  }

  if (t.moment === 'final-pressure') {
    const losing = sh > sa ? (m.away || 'visitante') : sa > sh ? (m.home || 'mandante') : null;
    reads.push({
      icon: '⏱',
      text: losing
        ? `Pressão final do ${losing} buscando empate — chance de BTTS ou gol tardio.`
        : `Reta final aberta — qualquer lance pode definir.`,
    });
  }

  // BTTS específico
  if (goals > 0 && ((sh === 0) !== (sa === 0))) {
    const losing = sh === 0 ? 'home' : 'away';
    const sotLos = n(m.stats?.shotsOnTarget?.[losing]);
    if (sotLos >= 3 && min >= 35) {
      reads.push({
        icon: '🎯',
        text: `Lado que não marcou criando — ${sotLos} no alvo. Probabilidade de BTTS elevada.`,
      });
    }
  }

  // Cartões (informativo)
  const cards = n(m.stats?.cards?.yellow?.total) + n(m.stats?.cards?.red?.total) * 2;
  if (cards >= 5 && min < 75) {
    reads.push({
      icon: '🟨',
      text: `Jogo aceso — ${cards} pontos de cartões já no ${min}′. Tendência Over cartões.`,
    });
  }

  if (!reads.length) {
    reads.push({ icon: '📊', text: 'Cenário equilibrado — sem padrão dominante neste momento.' });
  }
  return reads;
}

/* ============================================================
   PICKS — sugestões interpretadas, com risco e confiança
   ============================================================ */
function pickRisk(level) {
  return level === 'low'  ? { tag: 'BAIXO',  emoji: '🟢' }
       : level === 'high' ? { tag: 'ALTO',   emoji: '🔴' }
       :                    { tag: 'MÉDIO',  emoji: '🟡' };
}

/**
 * Filtra picks pelas preferências do usuário.
 * @param {Array} picks
 * @param {{markets?: string[], profile?: 'conservative'|'aggressive'|'balanced', minConfidence?: number}} prefs
 */
function filterPicksByPrefs(picks, prefs = {}) {
  if (!prefs || !picks?.length) return picks;
  let out = picks.slice();

  if (Array.isArray(prefs.markets) && prefs.markets.length) {
    out = out.filter((p) => prefs.markets.includes(p.market));
  }
  if (prefs.profile === 'conservative') {
    // só best/conservative + risco baixo + confiança >=70
    out = out.filter((p) =>
      (p.kind === 'best' || p.kind === 'conservative')
      && (p.risk?.tag === 'BAIXO' || p.risk?.tag === 'MÉDIO')
      && p.confidence >= 70);
  } else if (prefs.profile === 'aggressive') {
    // qualquer pick com confiança >=50
    out = out.filter((p) => p.confidence >= 50);
  }
  if (prefs.minConfidence) out = out.filter((p) => p.confidence >= prefs.minConfidence);
  return out;
}

function buildPicks(m, t) {
  const picks = [];
  const min = Math.max(1, n(m.minute));
  const sh = n(m.score?.home), sa = n(m.score?.away);
  const goals = sh + sa;
  const corners = n(m.stats?.corners?.total);
  const sot = n(m.stats?.shotsOnTarget?.total);
  const press = n(m.perMinute?.pressureIndex);

  /* ---------- BEST: melhor entrada combinando trends ---------- */
  if (t.corners === 'high' && min < 60) {
    const projCorners = Math.round((corners / min) * 95);
    const target = corners + 2; // Over corners + 2 vs atual
    picks.push({
      kind: 'best',
      market: 'corners',
      label: `Over ${target}.5 escanteios`,
      confidence: clamp(55 + (projCorners - target) * 4, 60, 90),
      risk: pickRisk('low'),
      reason: `Ritmo de ${(corners / min).toFixed(2)} cantos/min projeta ~${projCorners} no fim.`,
    });
  } else if (t.goals === 'high' && goals < 3) {
    picks.push({
      kind: 'best',
      market: 'goals',
      label: `Over ${goals + 0.5} gols`,
      confidence: clamp(55 + sot * 3 + Math.round(press * 0.3), 60, 90),
      risk: pickRisk('medium'),
      reason: `${sot} no alvo em ${min}′ + pressão IA ${pct(press)}.`,
    });
  } else if (t.moment === 'final-pressure' && goals > 0 && (sh === 0 || sa === 0)) {
    picks.push({
      kind: 'best',
      market: 'btts',
      label: 'BTTS Sim',
      confidence: clamp(60 + (m.bttsLikelihood || 0) * 0.3, 65, 88),
      risk: pickRisk('medium'),
      reason: `Pressão final do lado que ainda não marcou — chance de BTTS.`,
    });
  }

  /* ---------- ALTERNATIVA: oposta/menor risco ---------- */
  if (t.goals === 'low' && t.intensity !== 'high' && min >= 35) {
    picks.push({
      kind: 'alt',
      market: 'goals',
      label: `Under ${goals + 2}.5 gols`,
      confidence: clamp(60 + (45 - Math.min(45, min)), 60, 85),
      risk: pickRisk('low'),
      reason: 'Equilíbrio defensivo + baixa criação ofensiva.',
    });
  } else if (t.corners === 'mid' && min < 45) {
    const target = Math.max(corners + 1, 4);
    picks.push({
      kind: 'alt',
      market: 'corners',
      label: `Over ${target}.5 escanteios (HT)`,
      confidence: 62,
      risk: pickRisk('low'),
      reason: 'Volume de cantos consistente no 1º tempo.',
    });
  }

  /* ---------- AGRESSIVO: alto risco/alto retorno ---------- */
  if (t.goals === 'high' && t.intensity === 'high' && goals < 4) {
    picks.push({
      kind: 'aggressive',
      market: 'goals',
      label: `Over ${goals + 1.5} gols`,
      confidence: clamp(40 + sot * 2 + Math.round(press * 0.2), 45, 75),
      risk: pickRisk('high'),
      reason: `Cenário muito ofensivo — ${sot} no alvo, intensidade ALTA.`,
    });
  }

  /* ---------- CONSERVADOR: aposta segura ---------- */
  if (sh > 0 && sa > 0) {
    picks.push({
      kind: 'conservative',
      market: 'btts',
      label: 'BTTS Sim (já marcou)',
      confidence: 98,
      risk: pickRisk('low'),
      reason: 'Ambas já marcaram — mercado resolvido positivamente.',
    });
  } else if (t.corners === 'mid' || t.corners === 'high') {
    const target = Math.max(corners - 1, 3);
    if (target > 0) {
      picks.push({
        kind: 'conservative',
        market: 'corners',
        label: `Over ${target}.5 escanteios`,
        confidence: 88,
        risk: pickRisk('low'),
        reason: 'Mercado conservador — escanteios já próximos do gatilho.',
      });
    }
  }

  // Deduplica por (market+label)
  const seen = new Set();
  const dedup = [];
  for (const p of picks) {
    const k = `${p.market}:${p.label}`;
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(p);
  }

  // ⚠ GARANTIA: SEMPRE devolver pelo menos 1 pick — fallback "observar"
  if (!dedup.length) {
    if (min < 25) {
      dedup.push({
        kind: 'alt', market: 'goals', label: 'Aguardar leitura (jogo iniciando)',
        confidence: 50, risk: pickRisk('low'),
        reason: 'Cenário ainda imaturo — observe próximos 10–15 minutos antes de operar.',
      });
    } else if (t.intensity === 'weak') {
      dedup.push({
        kind: 'conservative', market: 'goals', label: `Under ${goals + 1.5} gols`,
        confidence: 60, risk: pickRisk('low'),
        reason: 'Jogo travado — Under é leitura defensiva natural.',
      });
    } else {
      dedup.push({
        kind: 'alt', market: 'pressure', label: 'Sem entrada clara',
        confidence: 50, risk: pickRisk('medium'),
        reason: 'Sem padrão dominante — aguarde gatilho mais nítido.',
      });
    }
  }
  return dedup;
}

/* ============================================================
   SUMMARY — uma frase curta resumindo
   ============================================================ */
function buildSummary(m, t, picks) {
  const top = picks.find((p) => p.kind === 'best') || picks[0];
  if (!top) {
    if (t.intensity === 'weak') return 'Jogo morno — aguardando catalisador.';
    return 'Cenário em desenvolvimento — sem leitura dominante.';
  }
  return `Leitura: ${top.label.toLowerCase()} (${top.confidence}%) — ${top.reason}`;
}

/* ============================================================
   PUBLIC API
   ============================================================ */
/**
 * Calcula insight completo. Se `prefs` for fornecido, devolve TAMBÉM
 * `picksFiltered` aplicando o filtro de mercado/perfil/confiança.
 * Frontend pode ignorar `prefs` e filtrar localmente — útil quando o
 * usuário muda o filtro entre re-renders sem novo socket round-trip.
 */
function computeInsight(match, prefs = null) {
  if (!match || !match.enriched || !match.stats) return null;
  const trends = {
    goals:     trendGoals(match),
    corners:   trendCorners(match),
    intensity: trendIntensity(match),
    moment:    trendMoment(match),
  };
  const reads = buildReads(match, trends);
  const picks = buildPicks(match, trends);
  const summary = buildSummary(match, trends, picks);
  const out = { trends, reads, picks, summary, computedAt: Date.now() };
  if (prefs) out.picksFiltered = filterPicksByPrefs(picks, prefs);
  return out;
}

module.exports = {
  computeInsight,
  filterPicksByPrefs,
  _internals: { trendGoals, trendCorners, trendIntensity, trendMoment, buildReads, buildPicks, buildSummary },
};
