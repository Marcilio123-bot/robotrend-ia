/**
 * Robotrend IA — Scanner Ao Vivo (LIVE)
 *
 * Consulta exclusivamente a API-Football (API-Sports) via o serviço
 * `footballProvider` (proxy para `apiFootball`).
 *
 * Se a API-Football não estiver configurada ou falhar, o scanner devolve
 * lista vazia e o painel exibe "Dados indisponíveis no momento.".
 * NÃO existe fallback para partidas sintéticas nem providers secundários.
 */

'use strict';

const { analyzeLiveMatch } = require('./analyzer');
const freshness = require('./freshness');
const consensus = require('./consensus');
const apiFootball = require('./services/footballProvider');

// STRICT_REAL_ONLY: bloqueia 100% qualquer fonte sintética residual.
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

/**
 * Live scanner usando a API-Football (via footballProvider).
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
      console.warn('[live] API-Football não configurada — retornando vazio.');
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
   *   Em casos raros a API-Football pode não devolver kickoff exato. Quando
   *   só temos o minuto, derivamos kickoffAt = now - minute*60s para que
   *   `freshness.checkMatchStrict` não rejeite o match em STRICT_REAL_ONLY.
   */
  mapNormalizedMatch(m) {
    const minute = Number(m.minute || 0);
    const kickoffRaw = m.kickoffAt || m.date || null;
    const kickoffFallback = kickoffRaw
      || new Date(Date.now() - Math.max(0, minute) * 60_000).toISOString();
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
      provider: 'api-football',
      dataQuality: m.dataQuality || 'full',
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
 * Scanner inerte — devolve lista vazia quando a API-Football não está
 * configurada. O sistema NUNCA devolve partidas sintéticas — preferimos
 * exibir "Dados indisponíveis no momento." no painel do que arriscar emitir
 * signals fake.
 */
class EmptyLiveScanner {
  constructor() { this.history = new Map(); this.acceptedOnce = new Set(); }
  list() { return []; }
  async tick() { return []; }
}

function createLiveScanner() {
  if (!apiFootball.isConfigured?.()) {
    console.warn('[live] API-Football não configurada — scanner inerte (retorna []). ' +
                 'Painel exibirá "Dados indisponíveis no momento." até API_FOOTBALL_KEY ser preenchida.');
    return new EmptyLiveScanner();
  }
  console.log('[live] ApiLiveScanner ativo' + (STRICT_REAL_ONLY ? ' (STRICT)' : '') +
              ' — provider: API-Football');
  return new ApiLiveScanner();
}

module.exports = { createLiveScanner };
