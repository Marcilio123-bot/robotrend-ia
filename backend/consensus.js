/**
 * Robotrend IA — Multi-API Consensus Engine
 *
 * Confirma (ou anota) que um match está LIVE em N fontes externas independentes.
 *
 * ============================================================
 *  MODOS DE OPERAÇÃO (env: MATCH_CONSENSUS_MODE)
 * ============================================================
 *
 *  - STRICT  → comportamento original: TODAS as fontes precisam concordar
 *              dentro da tolerância de timestamp. Divergência = match descartado.
 *              Use em produção de Signal Mode quando você precisa de altíssima
 *              certeza (ex.: cash bot operando).
 *
 *  - RELAXED → DEFAULT recomendado. Aceita o match se QUALQUER fonte o
 *              confirma, mas anota a qualidade:
 *                  • verified      → todas as fontes ativas concordam
 *                  • partial       → ≥1 mas <N fontes concordam (dentro da tolerância)
 *                  • single-source → apenas 1 fonte ou divergência grande
 *              Nenhum match é descartado. Ideal para mostrar dados no painel
 *              mesmo quando providers FREE (TheSportsDB) divergem do API-Football.
 *
 *  - OFF     → bypass total. Engine NÃO faz HTTP, devolve a lista intacta
 *              anotada como `single-source`. Use quando o poller único já
 *              é fonte de verdade suficiente (modo Scanner).
 *
 * Compat:
 *   - Se `MATCH_CONSENSUS_MODE` não estiver setado E `STRICT_REAL_ONLY=true`,
 *     o modo default é STRICT (comportamento legado).
 *   - Caso contrário, default = RELAXED.
 *
 * Fontes possíveis (todas com retry exponencial):
 *   1. STATUS   → API-Football v3/fixtures?live=all
 *   2. EVENTS   → API-Football v3/fixtures?live=all (filtra elapsed >= 1)
 *   3. ODDS     → The Odds API v4/sports/soccer/odds  ── OPCIONAL ──
 *
 * Regras compartilhadas:
 *   - Diferença máxima de timestamp entre fontes: 60s (configurável)
 *
 * Logs:
 *   [CONSENSUS]            X/Y matches confirmados pelas N APIs (modo)
 *   [CONSENSUS DIVERGENCE] match divergiu (reason, source faltante, spread)
 *   [CONSENSUS RETRY]      tentativa X/Y falhou
 *   [CONSENSUS FAIL]       source "name" indisponível
 *   [CONSENSUS BLOCK]      apenas em STRICT — bloqueando TODOS os matches
 *   [CONSENSUS RELAX]      em RELAXED — match aceito por 1 fonte (single-source)
 *   [CONSENSUS ODDS]       odds desativadas — modo fallback (somente 1x)
 */

'use strict';

const axios = require('axios');
const apiFootball = require('./services/footballProvider');
const { logExternalRequest } = require('./services/externalApiGuard');

const ENV = process.env.NODE_ENV || 'development';
const STRICT_REAL_ONLY = (() => {
  const raw = process.env.STRICT_REAL_ONLY;
  if (raw == null || raw === '') return ENV === 'production' || ENV === 'staging';
  return String(raw).toLowerCase() === 'true';
})();

/* ============================================================
   MATCH_CONSENSUS_MODE — strict | relaxed | off
   ------------------------------------------------------------
   Default:
     - STRICT  se STRICT_REAL_ONLY=true (compat com setup antigo)
     - RELAXED em qualquer outro caso (segue a recomendação do user)
   ============================================================ */
const VALID_MODES = new Set(['strict', 'relaxed', 'off']);
const CONSENSUS_MODE = (() => {
  const raw = String(process.env.MATCH_CONSENSUS_MODE || '').trim().toLowerCase();
  if (VALID_MODES.has(raw)) return raw;
  return STRICT_REAL_ONLY ? 'strict' : 'relaxed';
})();
console.log(`[CONSENSUS] modo ativo: ${CONSENSUS_MODE.toUpperCase()} (env MATCH_CONSENSUS_MODE=${process.env.MATCH_CONSENSUS_MODE || '(default)'})`);

// Retries default rebaixado para 1: apiFootball já faz retry interno
// com backoff exponencial, então retentar aqui só gerava 3x mais log
// de falha e quase nunca novas chamadas (cache/in-flight dedup).
const RETRIES            = Number(process.env.CONSENSUS_RETRIES            || 1);
const RETRY_DELAY_MS     = Number(process.env.CONSENSUS_RETRY_DELAY_MS     || 1_000);
const TS_TOLERANCE_MS    = Number(process.env.CONSENSUS_TS_TOLERANCE_MS    || 60_000);
const FETCH_TIMEOUT_MS   = Number(process.env.CONSENSUS_FETCH_TIMEOUT_MS   || 10_000);

const API_FOOTBALL_KEY  = process.env.API_FOOTBALL_KEY;
const API_FOOTBALL_HOST = process.env.API_FOOTBALL_HOST || 'api-football-v1.p.rapidapi.com';
const ODDS_API_KEY      = (process.env.ODDS_API_KEY || '').trim();

/* ============================================================
   ODDS opcional — flag explícita OU ausência de chave equivale a "opcional"
   ============================================================ */
const ODDS_OPTIONAL = (() => {
  const raw = process.env.ODDS_OPTIONAL;
  if (raw == null || raw === '') return !ODDS_API_KEY; // sem chave → opcional por padrão
  return String(raw).toLowerCase() === 'true';
})();
const ODDS_ENABLED = !!ODDS_API_KEY && !ODDS_OPTIONAL;

// Source list efetivo (recalculado conforme ODDS_ENABLED)
const SOURCE_NAMES = ODDS_ENABLED ? ['status', 'events', 'odds'] : ['status', 'events'];

// Warning único no boot
if (!ODDS_ENABLED) {
  const reason = !ODDS_API_KEY ? 'ODDS_API_KEY ausente' : 'ODDS_OPTIONAL=true';
  console.warn(`[CONSENSUS ODDS] modo fallback ativo (${reason}) — usando apenas API-Football (${SOURCE_NAMES.join('+')}). Matches NÃO serão bloqueados por ausência de odds.`);
}

/* ============================================================
   HELPERS
   ============================================================ */
function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function matchKey(m) {
  return `${normalize(m?.home)}__vs__${normalize(m?.away)}`;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function withRetry(name, fn, retries = RETRIES, baseDelay = RETRY_DELAY_MS) {
  let lastErr;
  for (let i = 1; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      console.warn(`[CONSENSUS RETRY] ${name} tentativa ${i}/${retries} falhou: ${e.message}`);
      if (i < retries) await sleep(baseDelay * i);
    }
  }
  throw new Error(`${name} falhou após ${retries} tentativas: ${lastErr?.message || 'unknown'}`);
}

/* ============================================================
   SOURCE ADAPTERS
   Cada um retorna um Map<matchKey, { status, timestamp, raw }>
   ============================================================ */
async function fetchStatusSource() {
  if (!apiFootball.isConfigured()) {
    console.warn('[CONSENSUS] API_FOOTBALL não configurada — source status vazia (sem HTTP)');
    return new Map();
  }
  // Reusa o cache/quota do serviço centralizado (chamada compartilhada
  // com events e com live.js — o dedup in-flight garante 1 round-trip).
  // `aggregate:false` força failover sequencial — não faz sentido agregar
  // aqui porque o consensus já compara source-by-source.
  const response = await apiFootball.getLiveFixtures({ aggregate: false });
  const out = new Map();
  for (const fx of response || []) {
    const status = fx?.fixture?.status?.short;
    if (!status) continue;
    const kickoff = new Date(fx.fixture.date).getTime();
    const elapsedMs = (fx.fixture.status.elapsed || 0) * 60_000;
    const ts = Number.isFinite(kickoff) ? kickoff + elapsedMs : Date.now();
    out.set(matchKey({ home: fx.teams.home.name, away: fx.teams.away.name }),
      { status, timestamp: ts, raw: { fixtureId: fx.fixture.id } });
  }
  return out;
}

async function fetchEventsSource() {
  if (!apiFootball.isConfigured()) {
    console.warn('[CONSENSUS] API_FOOTBALL não configurada — source events vazia (sem HTTP)');
    return new Map();
  }
  const response = await apiFootball.getLiveFixtures({ aggregate: false });
  const out = new Map();
  for (const fx of response || []) {
    const elapsed = fx?.fixture?.status?.elapsed;
    if (!elapsed || elapsed < 1) continue; // sem progressão = não confirmado pela feed de eventos
    out.set(matchKey({ home: fx.teams.home.name, away: fx.teams.away.name }),
      { status: 'live', timestamp: Date.now(), raw: { elapsed } });
  }
  return out;
}

async function fetchOddsSource() {
  if (!ODDS_API_KEY) {
    console.warn('[CONSENSUS] ODDS_API_KEY ausente — source odds vazia (sem HTTP)');
    return new Map();
  }
  const oddsUrl =
    'https://api.the-odds-api.com/v4/sports/soccer/odds' +
    `?apiKey=${encodeURIComponent(ODDS_API_KEY)}&regions=eu&markets=h2h&oddsFormat=decimal`;
  logExternalRequest('odds-api', 'GET', oddsUrl.replace(ODDS_API_KEY, '***'));
  const { data } = await axios.get(oddsUrl, { timeout: FETCH_TIMEOUT_MS });
  const out = new Map();
  const now = Date.now();
  for (const game of data || []) {
    const ts = new Date(game.commence_time).getTime();
    if (!Number.isFinite(ts)) continue;
    if (ts > now) continue;                       // ainda não começou
    if (now - ts > 4 * 3_600_000) continue;        // já passou da janela live
    out.set(matchKey({ home: game.home_team, away: game.away_team }),
      { status: 'live', timestamp: ts, raw: { oddsId: game.id } });
  }
  return out;
}

const DEFAULT_SOURCES = {
  status: fetchStatusSource,
  events: fetchEventsSource,
  odds:   fetchOddsSource,
};

/* ============================================================
   FETCH ALL SOURCES (paralelo, com retry por source)

   Em modo fallback (ODDS_ENABLED=false) a source "odds" NUNCA é chamada,
   mesmo que o caller passe um `sources` customizado contendo ela. Isso evita:
     - request HTTP desnecessária
     - retry loop de 3x falhando + sleep (~3s desperdiçados por ciclo)
     - log de "[CONSENSUS FAIL] odds indisponível" repetindo
   ============================================================ */
async function fetchAllSources(sources = DEFAULT_SOURCES) {
  const activeNames = SOURCE_NAMES.filter((n) => n !== 'odds' || ODDS_ENABLED);
  const entries = await Promise.all(
    activeNames.map(async (name) => {
      const fn = sources[name];
      if (typeof fn !== 'function') return [name, { ok: false, error: 'source não configurada' }];
      try {
        const data = await withRetry(name, fn);
        return [name, { ok: true, data }];
      } catch (e) {
        console.error(`[CONSENSUS FAIL] source "${name}" indisponível: ${e.message}`);
        return [name, { ok: false, error: e.message }];
      }
    })
  );
  return Object.fromEntries(entries);
}

/* ============================================================
   QUALIDADE DA FONTE — usada por todos os modos
   ------------------------------------------------------------
     verified      → todas as fontes ATIVAS concordam, spread dentro da tolerância
     partial       → ≥1 fonte mas <N fontes concordam (ou spread > tolerância)
     single-source → match conhecido por apenas 1 fonte (o poller principal)
   ============================================================ */
function deriveSourceQuality({ matchedSources, totalSources, spreadMs }) {
  if (matchedSources >= totalSources && totalSources >= 2 && spreadMs <= TS_TOLERANCE_MS) {
    return 'verified';
  }
  if (matchedSources >= 2) return 'partial';
  return 'single-source';
}

/**
 * Anota um match com `consensus` + `sourceQuality` mesmo quando o engine
 * não é executado (modo OFF, scanner endpoint, safe-mode). Útil para o
 * frontend renderizar o badge consistentemente em qualquer caminho.
 */
function annotateSourceQuality(m, extra = {}) {
  if (m.consensus && m.sourceQuality) return m;
  return {
    ...m,
    consensus: {
      mode: 'off',
      confirmedAt: Date.now(),
      sources: ['poller-cache'],
      ...extra,
    },
    sourceQuality: 'single-source',
  };
}

/* ============================================================
   CONFIRM MATCHES — entrypoint público, despacha por modo
   ============================================================
   opts:
     - mode:    'strict' | 'relaxed' | 'off'  (sobrescreve env)
     - strict:  bool legado — equivale a mode='strict' quando true
     - sources: injeção para testes
   ============================================================ */
async function confirmMatches(matches, opts = {}) {
  // Resolve modo efetivo (opts.mode > opts.strict > env)
  let mode = opts.mode || (opts.strict === true ? 'strict' : opts.strict === false ? 'off' : CONSENSUS_MODE);
  if (!VALID_MODES.has(mode)) mode = CONSENSUS_MODE;

  if (!Array.isArray(matches) || matches.length === 0) {
    return { confirmed: [], divergences: [], failedSources: [], mode };
  }

  // === MODO OFF — pass-through anotado =============================
  if (mode === 'off') {
    return {
      confirmed: matches.map((m) => annotateSourceQuality(m, { reason: 'mode:off' })),
      divergences: [],
      failedSources: [],
      mode,
    };
  }

  // Gates compartilhados (apply em STRICT e RELAXED).
  if (!apiFootball.isConfigured()) {
    console.warn('[CONSENSUS] API_FOOTBALL não configurada — degradando para single-source (modo: ' + mode + ')');
    return {
      confirmed: matches.map((m) => annotateSourceQuality(m, { reason: 'api-football-not-configured' })),
      divergences: [],
      failedSources: [],
      mode,
    };
  }
  if (apiFootball.isSafeMode && apiFootball.isSafeMode()) {
    console.warn('[CONSENSUS] safe-mode ativo — degradando para single-source (modo: ' + mode + ')');
    return {
      confirmed: matches.map((m) => annotateSourceQuality(m, { reason: 'provider-safe-mode' })),
      divergences: [],
      failedSources: [],
      mode,
    };
  }

  const sources = await fetchAllSources(opts.sources || DEFAULT_SOURCES);
  const activeNames = SOURCE_NAMES.filter((n) => sources[n] != null);
  const failedSources = activeNames.filter((n) => !sources[n]?.ok);

  // === MODO STRICT — comportamento original (bloqueia se source falhar) ===
  if (mode === 'strict') {
    if (failedSources.length) {
      console.error(
        `[CONSENSUS BLOCK] strict mode — sources falharam: ${failedSources.join(',')} → bloqueando ${matches.length} matches`
      );
      return { confirmed: [], divergences: [], failedSources, mode };
    }
    return resolveMatches(matches, sources, activeNames, { mode: 'strict' });
  }

  // === MODO RELAXED — nunca bloqueia, apenas anota qualidade =============
  // Sources que falharam viram "inativas" para esse ciclo, mas não impedem
  // a emissão dos matches. Cada match recebe sourceQuality conforme quantas
  // das fontes RESTANTES concordaram com ele.
  const liveSources = activeNames.filter((n) => sources[n]?.ok);
  if (failedSources.length) {
    console.warn(
      `[CONSENSUS RELAX] sources indisponíveis: ${failedSources.join(',')} — seguindo com ${liveSources.join('+') || '(nenhuma)'}`
    );
  }
  return resolveMatches(matches, sources, liveSources, { mode: 'relaxed', failedSources });
}

/**
 * Núcleo de resolução. Para cada match calcula:
 *   - quantas fontes ATIVAS o confirmam
 *   - spread de timestamp entre as fontes que confirmam
 *   - sourceQuality (verified / partial / single-source)
 *   - consensus.score (0..100)  — % de fontes que confirmam, descontado spread
 *
 * Em modo STRICT: rejeita match se alguma source faltar ou spread > tolerância.
 * Em modo RELAXED: aceita TUDO, só anota a qualidade.
 */
function resolveMatches(matches, sources, activeNames, { mode, failedSources = [] }) {
  const totalActive = activeNames.length;
  const confirmed = [];
  const divergences = [];
  let verifiedCount = 0, partialCount = 0, singleCount = 0;

  for (const m of matches) {
    const key = matchKey(m);
    const perSource = {};
    const matchedNames = [];
    const missingNames = [];

    for (const name of activeNames) {
      const entry = sources[name].data.get(key);
      perSource[name] = entry || null;
      if (entry) matchedNames.push(name);
      else missingNames.push(name);
    }

    const tsList = matchedNames.map((n) => perSource[n].timestamp).filter(Number.isFinite);
    const spread = tsList.length > 1 ? (Math.max(...tsList) - Math.min(...tsList)) : 0;

    // === STRICT: descarta match em qualquer ausência ou spread excedente
    if (mode === 'strict') {
      if (missingNames.length) {
        divergences.push({
          match: `${m.home} x ${m.away}`,
          reason: `não encontrado em source "${missingNames[0]}"`,
          missingSources: missingNames,
          matchedSources: matchedNames,
        });
        continue;
      }
      if (spread > TS_TOLERANCE_MS) {
        divergences.push({
          match: `${m.home} x ${m.away}`,
          reason: `timestamp spread ${(spread / 1000).toFixed(1)}s > ${TS_TOLERANCE_MS / 1000}s`,
          spreadMs: spread,
          timestamps: tsList,
        });
        continue;
      }
    }

    // === RELAXED (ou STRICT já validado): anota e aceita
    const quality = deriveSourceQuality({
      matchedSources: matchedNames.length,
      totalSources: totalActive,
      spreadMs: spread,
    });
    if (quality === 'verified') verifiedCount++;
    else if (quality === 'partial') partialCount++;
    else singleCount++;

    // Em RELAXED, registra divergência sem descartar — pra o user ver no log
    if (mode === 'relaxed' && missingNames.length) {
      console.log(`[CONSENSUS RELAX] aceito ${quality}: ${m.home} x ${m.away} (faltou em: ${missingNames.join(',')}, achado em: ${matchedNames.join(',') || 'nenhum'})`);
    }

    // Skip matches em RELAXED se NENHUMA fonte vier — match vem só do poller.
    // Ainda assim emitimos com `single-source` para o painel mostrar.
    const score = Math.round(
      (matchedNames.length / Math.max(1, totalActive)) * 100
      - Math.min(20, (spread / TS_TOLERANCE_MS) * 10)
    );

    confirmed.push({
      ...m,
      sourceQuality: quality,
      consensus: {
        mode,
        confirmedAt: Date.now(),
        sources: matchedNames.length ? matchedNames : ['poller-cache'],
        missingSources: missingNames,
        timestampSpreadMs: spread,
        score: Math.max(0, Math.min(100, score)),
        oddsEnabled: ODDS_ENABLED,
        failedSources: failedSources.length ? failedSources : undefined,
        perSource: Object.fromEntries(
          activeNames.map((n) => [n, perSource[n] ? { status: perSource[n].status, timestamp: perSource[n].timestamp } : null])
        ),
      },
    });
  }

  if (divergences.length) {
    console.warn(`[CONSENSUS DIVERGENCE] ${divergences.length} matches divergiram (modo: ${mode})`);
    for (const d of divergences.slice(0, 5)) {
      console.warn(`  - ${d.match}: ${d.reason}`);
    }
  }

  const summary = mode === 'relaxed'
    ? `verified=${verifiedCount} · partial=${partialCount} · single=${singleCount}`
    : `${confirmed.length}/${matches.length}`;
  console.log(
    `[CONSENSUS] modo=${mode} → ${confirmed.length}/${matches.length} matches emitidos · ${summary} · fontes ativas: ${activeNames.join('+') || '(nenhuma)'}`
  );

  return { confirmed, divergences, failedSources, mode };
}

module.exports = {
  confirmMatches,
  fetchAllSources,
  annotateSourceQuality,
  deriveSourceQuality,
  matchKey,
  normalize,
  withRetry,
  STRICT_REAL_ONLY,
  CONSENSUS_MODE,
  TS_TOLERANCE_MS,
  RETRIES,
  SOURCE_NAMES,
  ODDS_ENABLED,
  ODDS_OPTIONAL,
};
