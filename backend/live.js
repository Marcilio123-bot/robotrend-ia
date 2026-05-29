/**
 * Robotrend IA — Scanner Ao Vivo (LIVE)
 *
 * Em DEMO_MODE gera partidas simuladas com estatísticas dinâmicas e
 * envia atualizações via Socket.io. Em modo produção, consulta a
 * API-Football para puxar partidas reais.
 */

'use strict';

const { analyzeLiveMatch } = require('./analyzer');
const freshness = require('./freshness');
const consensus = require('./consensus');
const apiFootball = require('./services/footballProvider');

const DEMO = String(process.env.DEMO_MODE || 'false').toLowerCase() === 'true';
const API_KEY = (process.env.API_FOOTBALL_KEY || '').trim();

// STRICT_REAL_ONLY: bloqueia 100% qualquer fonte sintética.
// Default: true em production/staging, false em development.
const ENV = process.env.NODE_ENV || 'development';
const STRICT_REAL_ONLY = (() => {
  const raw = process.env.STRICT_REAL_ONLY;
  if (raw == null || raw === '') return ENV === 'production' || ENV === 'staging';
  return String(raw).toLowerCase() === 'true';
})();

// [MATCH DEBUG] gate — quando ativo (default: true), imprime resumo por
// tick: matches entrando, matches saindo, provider, ids, statuses e razões
// de drop em cada estágio (freshness + consensus). Desabilite com
// MATCH_DEBUG=false.
const MATCH_DEBUG_ENABLED = String(process.env.MATCH_DEBUG || 'true').toLowerCase() !== 'false';

const DEMO_LEAGUES = [
  'Brasileirão Série A',
  'Premier League',
  'La Liga',
  'Serie A Italiana',
  'Bundesliga',
  'Libertadores',
  'Champions League',
  'Copa do Brasil',
];

const DEMO_CLUBS = [
  ['Flamengo', 'Vasco'],
  ['Manchester City', 'Liverpool'],
  ['Real Madrid', 'Barcelona'],
  ['Inter', 'Juventus'],
  ['Bayern', 'Dortmund'],
  ['Palmeiras', 'Corinthians'],
  ['São Paulo', 'Santos'],
  ['Atlético-MG', 'Cruzeiro'],
  ['Grêmio', 'Internacional'],
  ['Botafogo', 'Fluminense'],
  ['PSG', 'Marseille'],
  ['Chelsea', 'Arsenal'],
];

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function chance(p) {
  return Math.random() < p;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Cria N partidas demo iniciais.
 */
function buildDemoMatches(n = 8) {
  const used = new Set();
  const matches = [];
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    let pair;
    do {
      pair = pick(DEMO_CLUBS);
    } while (used.has(pair[0]));
    used.add(pair[0]);
    used.add(pair[1]);

    const minute = randInt(5, 75);
    // kickoffAt = agora - minuto*60s (jogo iniciou há `minute` minutos)
    const kickoffAt = new Date(now - minute * 60_000).toISOString();
    const status = minute <= 45 ? '1H' : (minute < 50 ? 'HT' : '2H');
    matches.push({
      id: `demo-${now}-${i + 1}`,
      home: pair[0],
      away: pair[1],
      league: pick(DEMO_LEAGUES),
      minute,
      kickoffAt,
      date: kickoffAt,
      status,
      score: { home: randInt(0, 3), away: randInt(0, 2) },
      corners: randInt(2, 9),
      dangerousAttacks: randInt(20, 90),
      shots: randInt(3, 18),
      shotsOnTarget: randInt(0, 8),
      possession: randInt(35, 65),
      isLive: true,
      // === Origem SIMULADA — bloqueada em STRICT/prod ===
      isFromLiveAPI: false,
      source: 'demo',
      lastApiUpdate: null,
    });
  }
  return matches;
}

/**
 * Evolui uma partida demo (incrementa minuto e estatísticas).
 */
function evolveDemoMatch(m) {
  if (!m.isLive) return m;
  const next = { ...m };
  next.minute += randInt(1, 2);
  if (chance(0.35)) next.corners += 1;
  next.dangerousAttacks += randInt(0, 4);
  if (chance(0.4)) next.shots += 1;
  if (chance(0.2)) next.shotsOnTarget += 1;
  if (chance(0.08)) {
    if (chance(0.5)) next.score.home += 1;
    else next.score.away += 1;
  }
  next.possession = Math.max(30, Math.min(70, next.possession + randInt(-3, 3)));
  // Atualiza status conforme minuto
  next.status = next.minute <= 45 ? '1H' : '2H';
  if (next.minute >= 90) {
    next.minute = 90;
    next.isLive = false;
    next.status = 'FT';
  }
  return next;
}

/**
 * Live scanner em modo demo. Mantém estado em memória + histórico por
 * partida (para o cálculo de momentum nos últimos 10').
 */
class DemoLiveScanner {
  constructor() {
    this.matches = buildDemoMatches(10);
    this.history = new Map();
    this.acceptedOnce = new Set(); // IDs já logados como aceitos
  }

  list() {
    return this.matches;
  }

  pushHistory(match) {
    if (!this.history.has(match.id)) this.history.set(match.id, []);
    const arr = this.history.get(match.id);
    arr.push({
      minute: match.minute,
      corners: match.corners,
      shots: match.shots,
      dangerousAttacks: match.dangerousAttacks,
    });
    if (arr.length > 25) arr.shift();
  }

  /**
   * Faz um tick: evolui cada partida + retorna análises com histórico.
   * SEMPRE aplica filtro de freshness antes de retornar.
   */
  tick() {
    this.matches = this.matches.map(evolveDemoMatch);

    // Reposição de partidas encerradas (libera história anti-leak)
    const finishedIds = this.matches.filter((m) => !m.isLive).map((m) => m.id);
    if (finishedIds.length) {
      finishedIds.forEach((id) => {
        this.history.delete(id);
        this.acceptedOnce.delete(id);
      });
      this.matches = this.matches.filter((m) => m.isLive);
    }
    // Sempre repõe para manter um mínimo de 8 partidas vivas
    if (this.matches.length < 8) {
      const more = buildDemoMatches(10 - this.matches.length);
      this.matches = this.matches.concat(more);
    }

    // Filtro central: ignora qualquer partida antiga/finalizada/inválida
    const valid = freshness.filterRecent(this.matches, (m, reason) => {
      console.log(`[live] ignoring old match: ${m.home} x ${m.away} (${reason})`);
    });

    valid.forEach((m) => {
      this.pushHistory(m);
      if (!this.acceptedOnce.has(m.id)) {
        console.log(`[live] accepted recent match: ${m.home} x ${m.away} (min ${m.minute})`);
        this.acceptedOnce.add(m.id);
      }
    });
    // limpa do set ids que já não estão na lista (anti-leak)
    if (this.acceptedOnce.size > 50) {
      const validIds = new Set(valid.map((m) => m.id));
      for (const id of this.acceptedOnce) {
        if (!validIds.has(id)) this.acceptedOnce.delete(id);
      }
    }

    return valid.map((m) => ({
      match: m,
      analysis: analyzeLiveMatch(m, { history: this.history.get(m.id) || [] }),
    }));
  }
}

/**
 * Live scanner usando API-Football (RapidAPI).
 */
class ApiLiveScanner {
  constructor() {
    this.acceptedOnce = new Set();
  }

  async list() {
    const matches = await this.fetchLiveFixtures();
    return freshness.filterRecent(matches);
  }

  async tick() {
    const raw = await this.fetchLiveFixtures();
    const before = raw.length;
    const providerNow = apiFootball.providerName || (apiFootball.status?.()?.provider) || 'unknown';
    const filterFn = STRICT_REAL_ONLY ? freshness.filterRecentStrict : freshness.filterRecent;
    const dropReasons = [];
    const valid = filterFn(raw, (m, reason) => {
      dropReasons.push({
        id: m?.id != null ? String(m.id) : null,
        provider: m?.provider || m?.flags?.source || null,
        status: m?.status || null,
        minute: m?.minute ?? null,
        kickoffAt: m?.kickoffAt || m?.date || null,
        reason,
      });
      console.log(`[live] ignoring match: ${m?.home || '?'} x ${m?.away || '?'} (${reason})`);
    });
    const removed = before - valid.length;
    if (removed > 0) {
      console.log(`[LIVE FILTER] ${removed} jogos removidos por não serem reais`);
    }

    // [MATCH DEBUG] stage 1 — freshness gate (strict vs lenient)
    if (MATCH_DEBUG_ENABLED) {
      console.log('[MATCH DEBUG]', {
        stage: 'live.tick:freshness',
        beforeFilter: before,
        afterFilter: valid.length,
        provider: providerNow,
        strict: STRICT_REAL_ONLY,
        ids: valid.slice(0, 8).map((m) => String(m.id)),
        statuses: valid.slice(0, 8).map((m) => ({ id: String(m.id), status: m.status, minute: m.minute })),
        reasons: dropReasons.slice(0, 8),
      });
    }

    // Multi-API Consensus Engine — agora roda em TODOS os modos
    // (strict/relaxed/off, resolvido por consensus.CONSENSUS_MODE).
    //   - strict  : descarta matches que divergem ou se uma source falhar
    //   - relaxed : aceita TUDO, anota sourceQuality (verified/partial/single-source)
    //   - off     : pass-through anotado como single-source (sem HTTP extra)
    // Em qualquer modo, `match.consensus` + `match.sourceQuality` ficam disponíveis
    // para o pipeline e para o frontend.
    let toAnalyze = valid;
    let consensusInfo = { mode: null, failedSources: [], blocked: false };
    try {
      const { confirmed, failedSources, mode } = await consensus.confirmMatches(valid);
      consensusInfo = { mode, failedSources: failedSources || [], blocked: false };
      if (MATCH_DEBUG_ENABLED) {
        console.log('[MATCH DEBUG]', {
          stage: 'live.tick:consensus',
          beforeFilter: valid.length,
          afterFilter: confirmed.length,
          provider: providerNow,
          mode,
          failedSources: failedSources || [],
          ids: confirmed.slice(0, 8).map((m) => String(m.id)),
          statuses: confirmed.slice(0, 8).map((m) => ({ id: String(m.id), status: m.status, sourceQuality: m.sourceQuality })),
        });
      }
      if (mode === 'strict' && failedSources.length) {
        consensusInfo.blocked = true;
        this._lastDebugSnapshot = {
          ts: Date.now(),
          provider: providerNow,
          stage: 'consensus-block',
          beforeFreshness: before,
          afterFreshness: valid.length,
          afterConsensus: 0,
          consensus: consensusInfo,
          freshnessDrops: dropReasons.slice(0, 16),
        };
        console.error(
          `[CONSENSUS BLOCK] strict — ${failedSources.length} source(s) falharam: ${failedSources.join(',')} — 0 matches emitidos.`
        );
        return [];
      }
      toAnalyze = confirmed;
    } catch (e) {
      // RELAXED/OFF não devem falhar nunca aqui; STRICT degrada para zero matches.
      console.error(`[CONSENSUS BLOCK] erro inesperado: ${e.message} — degradando para feed bruto.`);
      toAnalyze = STRICT_REAL_ONLY ? [] : valid.map((m) => consensus.annotateSourceQuality(m, { reason: 'consensus-error' }));
      consensusInfo = { mode: 'error', failedSources: ['consensus-error'], blocked: STRICT_REAL_ONLY };
    }

    this._lastDebugSnapshot = {
      ts: Date.now(),
      provider: providerNow,
      stage: 'ok',
      beforeFreshness: before,
      afterFreshness: valid.length,
      afterConsensus: toAnalyze.length,
      consensus: consensusInfo,
      freshnessDrops: dropReasons.slice(0, 16),
    };

    toAnalyze.forEach((m) => {
      if (!this.acceptedOnce.has(m.id)) {
        console.log(`[live] accepted real match: ${m.home} x ${m.away} (min ${m.minute})`);
        this.acceptedOnce.add(m.id);
      }
    });
    if (this.acceptedOnce.size > 200) {
      const ids = new Set(toAnalyze.map((m) => m.id));
      for (const id of this.acceptedOnce) if (!ids.has(id)) this.acceptedOnce.delete(id);
    }
    return toAnalyze.map((m) => ({ match: m, analysis: analyzeLiveMatch(m) }));
  }

  async fetchLiveFixtures() {
    if (!apiFootball.isConfigured()) {
      console.warn('[live] API_FOOTBALL não configurada — retornando vazio.');
      return [];
    }
    // ZERO API CALL aqui — o poller central é o único owner do endpoint
    // /fixtures?live=all. Lemos o snapshot dele (atualizado a cada
    // FOOTBALL_POLL_INTERVAL_MS) e mapeamos para o formato legacy.
    //
    // Se o poller ainda não populou, fazemos UMA única tentativa via
    // apiFootball.getLiveFixtures() — que tem cache fresh + dedup in-flight,
    // então mesmo essa chamada de fallback é deduplicada.
    try {
      const { getPoller } = require('./workers/liveFootballPoller');
      const poller = getPoller();
      const matches = poller.getMatches();
      if (matches && matches.length) {
        return matches.map((m) => this.mapNormalizedMatch(m));
      }
      // Fallback raríssimo: poller ainda não rodou. Não força refresh
      // (evita pico de chamadas no boot). Volta vazio — próximo ciclo
      // do bot pegará o snapshot do poller.
      return [];
    } catch (err) {
      console.error('[live] erro lendo cache do poller:', err.message);
      return [];
    }
  }

  /**
   * Converte um match normalizado (do poller/fixtureNormalizer) para o
   * formato legacy esperado pelo analyzer/freshness/etc.
   *
   * IMPORTANTE — kickoff fallback:
   *   Providers free (TheSportsDB) podem não devolver `dateEvent`/`strTimestamp`
   *   em certos eventos. Sem timestamp, `freshness.checkMatchStrict` rejeita
   *   o match com "sem timestamp real" — derrubando jogos LIVE válidos no
   *   STRICT_REAL_ONLY (default em production). Quando o provider entregou
   *   apenas o minuto, derivamos kickoffAt = now - minute*60s.
   *
   * IMPORTANTE — provider:
   *   `source` é mantido como 'api-football' por compat (signal source guard
   *   espera `api-*`). O provider original (thesportsdb/sofascore/apisports)
   *   fica preservado em `provider` para logs e diagnóstico.
   */
  mapNormalizedMatch(m) {
    const minute = Number(m.minute || 0);
    const kickoffRaw = m.kickoffAt || m.date || null;
    const kickoffFallback = kickoffRaw
      || new Date(Date.now() - Math.max(0, minute) * 60_000).toISOString();
    const originalProvider = m.provider || m.flags?.source || null;
    return {
      id: String(m.fixtureId || m.id),
      home: m.home,
      away: m.away,
      league: m.league?.name || m.league || '',
      minute,
      status: m.status,
      kickoffAt: kickoffFallback,
      date: kickoffFallback,
      kickoffDerived: !kickoffRaw,
      score: {
        home: Number(m.score?.home || 0),
        away: Number(m.score?.away || 0),
      },
      corners: Number(m.stats?.corners?.total || 0),
      dangerousAttacks: Number(m.stats?.dangerousAttacks?.total || 0),
      shots: Number(m.stats?.shots?.total || 0),
      shotsOnTarget: Number(m.stats?.shotsOnTarget?.total || 0),
      possession: Number(m.stats?.possession?.home || 50),
      isLive: freshness.isLiveStatus(m.status),
      isFromLiveAPI: true,
      source: 'api-football',
      provider: originalProvider || 'api-football',
      dataQuality: m.dataQuality || (originalProvider === 'thesportsdb' || originalProvider === 'sofascore' ? 'partial' : 'full'),
      lastApiUpdate: m.lastApiUpdate || Date.now(),
    };
  }

  /** Último snapshot de debug (povoado a cada tick). */
  getLastDebugSnapshot() {
    return this._lastDebugSnapshot || null;
  }

  mapFixture(fix) {
    const stats = fix.statistics || [];
    const getStat = (team, type) => {
      const teamStats = stats.find((s) => s.team.id === team);
      if (!teamStats) return 0;
      const row = teamStats.statistics.find((x) => x.type === type);
      return Number(row?.value || 0);
    };
    const homeId = fix.teams.home.id;
    const awayId = fix.teams.away.id;
    const statusShort = fix.fixture.status?.short;
    return {
      id: String(fix.fixture.id),
      home: fix.teams.home.name,
      away: fix.teams.away.name,
      league: fix.league?.name,
      minute: fix.fixture.status?.elapsed || 0,
      status: statusShort,
      kickoffAt: fix.fixture.date,
      date: fix.fixture.date,
      score: { home: fix.goals.home || 0, away: fix.goals.away || 0 },
      corners:
        getStat(homeId, 'Corner Kicks') + getStat(awayId, 'Corner Kicks'),
      dangerousAttacks:
        getStat(homeId, 'Dangerous Attacks') + getStat(awayId, 'Dangerous Attacks'),
      shots:
        getStat(homeId, 'Total Shots') + getStat(awayId, 'Total Shots'),
      shotsOnTarget:
        getStat(homeId, 'Shots on Goal') + getStat(awayId, 'Shots on Goal'),
      possession: getStat(homeId, 'Ball Possession') || 50,
      isLive: freshness.isLiveStatus(statusShort),
      // === Origem REAL — única forma de habilitar emissão de sinal ===
      isFromLiveAPI: true,
      source: 'api-football',
      lastApiUpdate: Date.now(),
    };
  }
}

/**
 * Scanner inerte — devolve lista vazia. Usado quando nenhum provider real
 * está disponível E o usuário NÃO pediu explicitamente DEMO_MODE=true.
 * Previne o gargalo histórico onde a ausência de API_FOOTBALL_KEY fazia
 * o sistema cair em DemoLiveScanner e emitir signals FAKE de "Chelsea x
 * Arsenal" como se fossem reais.
 */
class EmptyLiveScanner {
  constructor() { this.history = new Map(); this.acceptedOnce = new Set(); }
  list() { return []; }
  async tick() { return []; }
}

function createLiveScanner() {
  // 1) STRICT_REAL_ONLY — só ApiLiveScanner com proteção API
  if (STRICT_REAL_ONLY) {
    if (DEMO) {
      console.warn('[live] STRICT_REAL_ONLY=true sobrepõe DEMO_MODE — fonte sintética desabilitada.');
    }
    if (!apiFootball.hasAnyConfiguredProvider?.() && !apiFootball.isConfigured?.()) {
      console.warn('[live] STRICT_REAL_ONLY=true + nenhum provider na chain — scanner inerte (retorna []).');
      return new EmptyLiveScanner();
    }
    console.log('[live] ApiLiveScanner ativo (STRICT) — provider: ' + (apiFootball.providerName || '?') +
                ' · chain: ' + (apiFootball.priority?.join('→') || '?'));
    return new ApiLiveScanner();
  }

  // 2) Dev com DEMO_MODE EXPLICITAMENTE solicitado pelo usuário
  if (DEMO) {
    console.warn('[live] DemoLiveScanner ativo (DEMO_MODE=true) — emitindo dados SINTÉTICOS, ' +
                 'signals NÃO são reais e devem ser ignorados em produção.');
    return new DemoLiveScanner();
  }

  // 3) Dev sem DEMO mas com algum provider real (sofascore/tsdb/apisports/etc.)
  //    O orchestrator footballProvider.isConfigured() retorna true para qualquer
  //    provider disponível — incluindo sofascore que NÃO precisa de chave.
  if (apiFootball.hasAnyConfiguredProvider?.() || apiFootball.isConfigured?.()) {
    console.log('[live] ApiLiveScanner ativo via orchestrator — provider: ' +
                (apiFootball.providerName || '?') +
                ' (priority: ' + (apiFootball.priority?.join('→') || '?') + ')');
    return new ApiLiveScanner();
  }

  // 4) Último recurso: nenhum provider real E sem DEMO_MODE explícito.
  //    NÃO devolvemos DemoLiveScanner — seria fonte de signals fake.
  console.warn('[live] Nenhum provider real configurado e DEMO_MODE!=true. ' +
               'Scanner inerte — bot.js NÃO emitirá signals até você ajustar o .env.');
  return new EmptyLiveScanner();
}

module.exports = { createLiveScanner };
