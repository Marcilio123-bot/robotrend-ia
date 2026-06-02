/**
 * Robotrend IA — Análise Pré-Live (BTTS)
 *
 * Busca exclusivamente fixtures REAIS via API-Football (API-Sports).
 * Se a API-Football não estiver configurada, retorna lista vazia —
 * partidas sintéticas foram removidas do sistema.
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
    // ============================================================
    // [PRELIVE DEBUG] Instrumentação TEMPORÁRIA — remover após
    // diagnosticar a causa de /api/prelive → {fixtures:[]}. Apenas
    // console.log; não altera nenhuma regra de negócio.
    // ============================================================
    const __dbgT0 = Date.now();
    const __dbgNowUTC = new Date().toISOString();
    const __dbgNowBRT = new Date(Date.now() - 3 * 3600_000)
      .toISOString().replace('T', ' ').replace('Z', ' BRT');
    console.log(`[PRELIVE DEBUG] === ciclo iniciado === now UTC=${__dbgNowUTC} | BRT=${__dbgNowBRT}`);

    if (!apiFootball.isConfigured?.()) {
      console.warn('[prelive] API-Football não configurada — retornando [].');
      console.log('[PRELIVE DEBUG] abort: !isConfigured() → []');
      return [];
    }
    // SAFE-MODE: não consome API. Devolve [] e deixa o frontend exibir aviso.
    const __dbgSafeMode = !!(apiFootball.isSafeMode && apiFootball.isSafeMode());
    console.log(`[PRELIVE DEBUG] SAFE_MODE no início do ciclo = ${__dbgSafeMode}`);
    if (apiFootball.isSafeMode && apiFootball.isSafeMode()) {
      console.warn('[prelive] safe-mode ativo — pulando ciclo (quota baixa).');
      return [];
    }
    try {
      const today = new Date().toISOString().slice(0, 10);
      console.log(`[PRELIVE DEBUG] query date (UTC slice)=${today} | STRICT_REAL_ONLY=${STRICT_REAL_ONLY} | PRELIVE_MAX_FIXTURES=${PRELIVE_MAX_FIXTURES}`);
      const response = await apiFootball.getFixturesByDate(today);
      console.log(`[PRELIVE DEBUG] response length (API-Football fixtures?date=${today}) = ${(response || []).length}`);

      // ============================================================
      // PIPELINE (nova ordem):
      //   1) Filtrar TODA a resposta da API (sem cortar)
      //   2) slice(0, PRELIVE_MAX_FIXTURES) sobre o filtrado
      //   3) Enrich (custa 2 calls/fixture) só nos finalistas
      // Antes era slice → enrich → filter, o que zerava a lista
      // quando os primeiros jogos do dia já estavam encerrados.
      // ============================================================

      // Constrói candidatos leves (campos que filterUpcoming* lê:
      // id, startsAt, status). Mantém ref __raw para o enrich.
      const candidates = (response || []).map((fx) => ({
        id: String(fx?.fixture?.id ?? ''),
        startsAt: fx?.fixture?.date,
        status: fx?.fixture?.status?.short,
        home: fx?.teams?.home?.name,
        away: fx?.teams?.away?.name,
        league: fx?.league?.name,
        __raw: fx,
      }));
      const beforeFilter = candidates.length;
      console.log(`[PRELIVE DEBUG] entram antes do slice/filtro = ${beforeFilter}`);

      const filterFn = STRICT_REAL_ONLY ? freshness.filterUpcomingStrict : freshness.filterUpcoming;
      const filtered = filterFn(candidates, (c, reason) => {
        console.log(`[prelive] ignoring fixture: ${c?.home || '?'} x ${c?.away || '?'} (${reason})`);
      });
      console.log(`[PRELIVE DEBUG] passam no filtro (${STRICT_REAL_ONLY ? 'filterUpcomingStrict' : 'filterUpcoming'}) = ${filtered.length} (removidos=${beforeFilter - filtered.length})`);

      // Agora sim cortamos: pegamos os PRELIVE_MAX_FIXTURES próximos
      // (válidos) — economizando 2 calls × N no enrich.
      const sliced = filtered.slice(0, PRELIVE_MAX_FIXTURES);
      console.log(`[PRELIVE DEBUG] após slice(0,${PRELIVE_MAX_FIXTURES}) = ${sliced.length}`);

      // Diagnóstico horário UTC/BRT dos selecionados para enrich
      sliced.forEach((c, i) => {
        try {
          const t = c.startsAt ? new Date(c.startsAt).getTime() : null;
          const hDelta = t != null ? ((t - Date.now()) / 3_600_000).toFixed(2) : 'n/a';
          const brt = t != null
            ? new Date(t - 3 * 3600_000).toISOString().replace('T', ' ').replace('Z', '')
            : 'n/a';
          console.log(`[PRELIVE DEBUG]   #${i + 1} ${c.home} x ${c.away} | liga=${c.league} | status=${c.status || '?'} | UTC=${c.startsAt} | BRT=${brt} | hΔ=${hDelta}h`);
        } catch (_) { /* log only */ }
      });

      const enriched = await Promise.all(
        sliced.map((c) => this.enrich(c.__raw))
      );
      const usable = enriched.filter(Boolean);
      const __dbgSafeModeMid = !!(apiFootball.isSafeMode && apiFootball.isSafeMode());
      console.log(`[PRELIVE DEBUG] saem do enrich = ${usable.length} (de ${sliced.length}; ${sliced.length - usable.length} null) | SAFE_MODE pós-enrich=${__dbgSafeModeMid}`);

      console.log(`[PRELIVE DEBUG] === fim ciclo === valid=${usable.length} | tempo=${Date.now() - __dbgT0}ms`);
      return usable.map((fx) => Object.assign(analyzePrelive(fx), {
        source: fx.source,
        isFromLiveAPI: fx.isFromLiveAPI,
        lastApiUpdate: fx.lastApiUpdate,
      }));
    } catch (err) {
      if (err.code === 'SAFE_MODE') {
        console.warn('[prelive] safe-mode bloqueou chamada — sem cache, devolvendo [].');
        console.log('[PRELIVE DEBUG] catch SAFE_MODE → []');
        return [];
      }
      console.error('[prelive] erro API:', err.message);
      console.log(`[PRELIVE DEBUG] catch genérico: code=${err?.code || '?'} msg=${err?.message || '?'}`);
      return [];
    }
  }

  async enrich(fix) {
    try {
      // Re-check de safe-mode entre fixtures — pode ter ativado durante o ciclo
      if (apiFootball.isSafeMode && apiFootball.isSafeMode()) {
        // [PRELIVE DEBUG] temporário — remover após diagnóstico
        console.log(`[PRELIVE DEBUG] enrich null fixture=${fix?.fixture?.id} motivo=safe-mode mid-cycle`);
        return null;
      }
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
      // [PRELIVE DEBUG] temporário — remover após diagnóstico
      console.log(`[PRELIVE DEBUG] enrich null fixture=${fix?.fixture?.id} motivo=${e?.code || 'erro'} ${e?.message || ''}`);
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
 * Usado quando a API-Football não está configurada — devolve [] e deixa
 * o painel exibir "Dados indisponíveis no momento.".
 */
class EmptyPreliveScanner {
  async list() { return []; }
}

function createPreliveScanner() {
  if (apiFootball.isConfigured?.()) {
    console.log('[prelive] ApiPreliveScanner' + (STRICT_REAL_ONLY ? ' (STRICT)' : '') +
                ' — provider: API-Football');
    return new ApiPreliveScanner();
  }
  console.warn('[prelive] API-Football não configurada — scanner inerte. ' +
               'Painel exibirá "Dados indisponíveis no momento." até API_FOOTBALL_KEY ser preenchida.');
  return new EmptyPreliveScanner();
}

module.exports = { createPreliveScanner };
