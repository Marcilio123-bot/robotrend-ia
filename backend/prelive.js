/**
 * Robotrend IA — Análise Pré-Live (BTTS)
 *
 * Em DEMO_MODE gera fixtures com histórico simulado para os últimos 6
 * jogos de cada time. Em produção busca esses dados na API-Football.
 */

'use strict';

const { analyzePrelive } = require('./analyzer');
const freshness = require('./freshness');
const apiFootball = require('./services/apiFootball');

const DEMO = String(process.env.DEMO_MODE || 'false').toLowerCase() === 'true';
const API_KEY = process.env.API_FOOTBALL_KEY;

const ENV = process.env.NODE_ENV || 'development';
const STRICT_REAL_ONLY = (() => {
  const raw = process.env.STRICT_REAL_ONLY;
  if (raw == null || raw === '') return ENV === 'production' || ENV === 'staging';
  return String(raw).toLowerCase() === 'true';
})();

const DEMO_FIXTURES = [
  { home: 'Flamengo', away: 'Palmeiras', league: 'Brasileirão Série A' },
  { home: 'Real Madrid', away: 'Atlético de Madrid', league: 'La Liga' },
  { home: 'Manchester City', away: 'Arsenal', league: 'Premier League' },
  { home: 'Inter', away: 'Milan', league: 'Serie A Italiana' },
  { home: 'Bayern', away: 'Leverkusen', league: 'Bundesliga' },
  { home: 'PSG', away: 'Monaco', league: 'Ligue 1' },
  { home: 'Boca Juniors', away: 'River Plate', league: 'Libertadores' },
  { home: 'São Paulo', away: 'Corinthians', league: 'Brasileirão Série A' },
];

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function chance(p) {
  return Math.random() < p;
}

function buildLast6(profile) {
  const list = [];
  for (let i = 0; i < 6; i++) {
    const scored = chance(profile.scoreChance) ? randInt(1, 3) : 0;
    const conceded = chance(profile.concedeChance) ? randInt(1, 3) : 0;
    list.push({
      goalsFor: scored,
      goalsAgainst: conceded,
      shots: randInt(8, 18),
    });
  }
  return list;
}

function buildDemoFixtures() {
  // Limita ao máximo de horas válidas da janela pré-live
  const maxHours = Math.min(freshness.FUTURE_HOURS_LIMIT, 12);
  return DEMO_FIXTURES.map((f, i) => {
    const homeProfile = { scoreChance: 0.7 + Math.random() * 0.25, concedeChance: 0.4 + Math.random() * 0.4 };
    const awayProfile = { scoreChance: 0.55 + Math.random() * 0.3, concedeChance: 0.45 + Math.random() * 0.4 };
    // Espalha fixtures nas próximas N horas (sempre futuro próximo, nunca passado)
    const offsetHours = 0.5 + ((i % maxHours) * (maxHours - 0.5)) / DEMO_FIXTURES.length;
    return {
      id: `pre-${i + 1}`,
      home: f.home,
      away: f.away,
      league: f.league,
      startsAt: new Date(Date.now() + offsetHours * 3600 * 1000).toISOString(),
      homeLast6: buildLast6(homeProfile),
      awayLast6: buildLast6(awayProfile),
      isFromLiveAPI: false,
      source: 'demo-prelive',
      lastApiUpdate: null,
    };
  });
}

class DemoPreliveScanner {
  list() {
    const fixtures = buildDemoFixtures();
    const before = fixtures.length;
    const valid = freshness.filterUpcoming(fixtures, (fx, reason) => {
      console.log(`[prelive] ignoring old fixture: ${fx.home} x ${fx.away} (${reason})`);
    });
    const removed = before - valid.length;
    if (removed > 0) console.log(`[PRELIVE FILTER] ${removed} fixtures removidos`);
    // Propaga tags de origem na análise para o guard em bot.runPrelive saber
    return valid.map((fx) => Object.assign(analyzePrelive(fx), {
      source: fx.source,
      isFromLiveAPI: fx.isFromLiveAPI,
      lastApiUpdate: fx.lastApiUpdate,
    }));
  }
}

// Máximo de fixtures pré-live que enriquecemos por ciclo. Cada fixture
// custa 2 calls (last6 home + last6 away). 5 fixtures = 10 calls.
// Sem essa quebra o prelive antigo gastava 50 calls/ciclo no plano grátis.
const PRELIVE_MAX_FIXTURES = Number(process.env.PRELIVE_MAX_FIXTURES || 5);

class ApiPreliveScanner {
  async list() {
    if (!API_KEY) {
      console.warn('[prelive] API_FOOTBALL_KEY ausente — retornando [].');
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

function createPreliveScanner() {
  if (STRICT_REAL_ONLY) {
    if (!API_KEY) {
      console.warn('[prelive] STRICT_REAL_ONLY=true e API_FOOTBALL_KEY ausente — scanner retornará [] sempre.');
    }
    if (DEMO) {
      console.warn('[prelive] STRICT_REAL_ONLY=true sobrepõe DEMO_MODE — fonte sintética desabilitada.');
    }
    return new ApiPreliveScanner();
  }
  if (DEMO || !API_KEY) return new DemoPreliveScanner();
  return new ApiPreliveScanner();
}

module.exports = { createPreliveScanner };
