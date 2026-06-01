/**
 * Robotrend IA — Análise Pré-Live (BTTS)
 *
 * Busca exclusivamente fixtures REAIS via providers configurados em
 * FOOTBALL_PROVIDER_PRIORITY. Se nenhum provider real estiver disponível,
 * retorna lista vazia — partidas sintéticas foram removidas do sistema.
 */

'use strict';

const { analyzePrelive } = require('./analyzer');
const freshness = require('./freshness');
const apiFootball = require('./services/footballProvider');

const ENV = process.env.NODE_ENV || 'development';
const STRICT_REAL_ONLY = (() => {
  const raw = process.env.STRICT_REAL_ONLY;
  if (raw == null || raw === '') return ENV === 'production' || ENV === 'staging';
  return String(raw).toLowerCase() === 'true';
})();

// Máximo de fixtures pré-live que enriquecemos por ciclo. Cada fixture
// custa 2 calls (last6 home + last6 away). 5 fixtures = 10 calls.
// Sem essa quebra o prelive antigo gastava 50 calls/ciclo no plano grátis.
const PRELIVE_MAX_FIXTURES = Number(process.env.PRELIVE_MAX_FIXTURES || 5);

class ApiPreliveScanner {
  async list() {
    if (!apiFootball.hasAnyConfiguredProvider?.() && !apiFootball.isConfigured?.()) {
      console.warn('[prelive] nenhum provider configurado na chain — retornando [].');
      return [];
    }
    // SAFE-MODE: não consome API. Devolve [] e deixa o frontend exibir aviso.
    if (apiFootball.isSafeMode && apiFootball.isSafeMode()) {
      console.warn('[prelive] safe-mode ativo — pulando ciclo (quota baixa).');
      return [];
    }
    try {
      const today = new Date().toISOString().slice(0, 10);
      const response = await apiFootball.getFixturesByDate(today);
      // CAP DURO: enriquecer no máximo PRELIVE_MAX_FIXTURES por ciclo.
      // O endpoint /fixtures?date= devolve centenas; antes pegávamos 25
      // e disparávamos 50 calls de last6 — agora 5 × 2 = 10 calls.
      const fixtures = (response || []).slice(0, PRELIVE_MAX_FIXTURES);
      const enriched = await Promise.all(
        fixtures.map((fx) => this.enrich(fx))
      );
      const usable = enriched.filter(Boolean);
      const before = usable.length;
      const filterFn = STRICT_REAL_ONLY ? freshness.filterUpcomingStrict : freshness.filterUpcoming;
      const valid = filterFn(usable, (fx, reason) => {
        console.log(`[prelive] ignoring fixture: ${fx?.home || '?'} x ${fx?.away || '?'} (${reason})`);
      });
      const removed = before - valid.length;
      if (removed > 0) console.log(`[PRELIVE FILTER] ${removed} fixtures removidos por não serem reais`);
      return valid.map((fx) => Object.assign(analyzePrelive(fx), {
        source: fx.source,
        isFromLiveAPI: fx.isFromLiveAPI,
        lastApiUpdate: fx.lastApiUpdate,
      }));
    } catch (err) {
      if (err.code === 'SAFE_MODE') {
        console.warn('[prelive] safe-mode bloqueou chamada — sem cache, devolvendo [].');
        return [];
      }
      console.error('[prelive] erro API:', err.message);
      return [];
    }
  }

  async enrich(fix) {
    try {
      // Re-check de safe-mode entre fixtures — pode ter ativado durante o ciclo
      if (apiFootball.isSafeMode && apiFootball.isSafeMode()) return null;
      const [homeLast, awayLast] = await Promise.all([
        this.lastMatches(fix.teams.home.id),
        this.lastMatches(fix.teams.away.id),
      ]);
      return {
        id: String(fix.fixture.id),
        home: fix.teams.home.name,
        away: fix.teams.away.name,
        league: fix.league?.name,
        startsAt: fix.fixture.date,
        homeLast6: homeLast,
        awayLast6: awayLast,
        // Pré-live é REAL da API, mas NÃO é "live" — não habilita sinal live.
        isFromLiveAPI: false,
        source: 'api-football-prelive',
        lastApiUpdate: Date.now(),
      };
    } catch (e) {
      return null;
    }
  }

  async lastMatches(teamId) {
    try {
      const response = await apiFootball.getFixturesByTeam(teamId, { last: 6 });
      return (response || []).map((fx) => {
        const isHome = fx.teams.home.id === teamId;
        return {
          goalsFor: isHome ? fx.goals.home : fx.goals.away,
          goalsAgainst: isHome ? fx.goals.away : fx.goals.home,
          shots: 0,
        };
      });
    } catch (e) {
      if (e.code === 'SAFE_MODE') return [];
      throw e;
    }
  }
}

/**
 * Scanner inerte (substitui o antigo DemoPreliveScanner).
 * Usado quando não há provider real configurado — devolve [] e deixa o
 * painel exibir "Dados indisponíveis no momento.".
 */
class EmptyPreliveScanner {
  async list() { return []; }
}

function createPreliveScanner() {
  if (apiFootball.hasAnyConfiguredProvider?.() || apiFootball.isConfigured?.()) {
    console.log('[prelive] ApiPreliveScanner' + (STRICT_REAL_ONLY ? ' (STRICT)' : '') +
                ' — provider: ' + (apiFootball.providerName || '?'));
    return new ApiPreliveScanner();
  }
  console.warn('[prelive] Nenhum provider real configurado — scanner inerte. ' +
               'Painel exibirá "Dados indisponíveis no momento." até FOOTBALL_PROVIDER_PRIORITY ser ajustado.');
  return new EmptyPreliveScanner();
}

module.exports = { createPreliveScanner };
