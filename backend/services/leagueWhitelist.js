/**
 * Robotrend IA — League Whitelist (Filtro de ligas populares Bet365)
 *
 * Define a lista RÍGIDA de competições populares e amplamente disponíveis
 * na Bet365. O sistema só deve exibir jogos e gerar sinais quando a
 * competição estiver dentro desta whitelist.
 *
 * Por que existe:
 *   A IA estava enviando sinais de ligas desconhecidas, divisões inferiores,
 *   categorias de base (U21/U20/Sub-17), times B/reservas e amistosos pouco
 *   relevantes — jogos sem mercado completo na casa de apostas. Isso polui o
 *   painel e gera sinais de baixíssima liquidez.
 *
 * Estratégia de matching (2 camadas + exclusão dura):
 *   1. EXCLUSÃO — qualquer liga cujo nome/país bata com um token de exclusão
 *      (amistoso, juvenil, reserva, feminino, etc.) é SEMPRE rejeitada,
 *      mesmo que case com a whitelist por engano.
 *   2. WHITELIST por ID — IDs oficiais da API-Football (precisos, estáveis).
 *   3. WHITELIST por NOME — fallback robusto caso o ID mude entre temporadas
 *      ou venha ausente. Competições ambíguas (ex.: "Serie A" existe em vários
 *      países) exigem que o país também bata.
 *
 * Configuração:
 *   - SIGNALS_POPULAR_LEAGUES_ONLY (env, default 'true') → estado inicial.
 *   - Pode ser alternado em runtime pelo painel admin (setPopularOnly()),
 *     com persistência best-effort em disco para sobreviver a reinícios.
 *   - Quando DESLIGADO, shouldAllow() libera todas as ligas (comportamento legado).
 */

'use strict';

const fs = require('fs');
const path = require('path');

/* ============================================================
   WHITELIST — IDs oficiais API-Football (v3)
   ============================================================ */
const WHITELIST_IDS = new Set([
  // --- Brasil ---
  71,   // Brasileirão Série A
  72,   // Brasileirão Série B
  73,   // Copa do Brasil
  // --- CONMEBOL (clubes) ---
  13,   // Libertadores
  11,   // Sul-Americana (Sudamericana)
  // --- Inglaterra ---
  39,   // Premier League
  40,   // Championship
  45,   // FA Cup
  // --- Espanha ---
  140,  // La Liga
  143,  // Copa del Rey
  // --- Itália ---
  135,  // Serie A
  137,  // Coppa Italia
  // --- Alemanha ---
  78,   // Bundesliga
  // --- França ---
  61,   // Ligue 1
  // --- Holanda ---
  88,   // Eredivisie
  // --- Portugal ---
  94,   // Primeira Liga
  // --- EUA / México ---
  253,  // MLS
  262,  // Liga MX
  // --- UEFA (clubes) ---
  2,    // Champions League
  3,    // Europa League
  848,  // Conference League
  // --- Seleções (grandes torneios) ---
  1,    // Copa do Mundo (World Cup)
  4,    // Eurocopa (Euro Championship)
  9,    // Copa América
  5,    // UEFA Nations League
  10,   // Amistosos de Seleções (International Friendlies — só seleções principais)
  // --- Eliminatórias de seleções ---
  29,   // WC Qualification Africa
  30,   // WC Qualification Asia
  31,   // WC Qualification CONCACAF
  32,   // WC Qualification Europe
  33,   // WC Qualification Oceania
  34,   // WC Qualification South America
  960,  // Euro Championship - Qualification
]);

/* ============================================================
   EXCLUSÃO DURA — sempre rejeita (mesmo se casar na whitelist).
   Aplicada sobre `${name} ${country}` em lowercase.
   ============================================================ */
const EXCLUDE_RX = new RegExp(
  [
    // Amistosos de CLUBES (amistosos de SELEÇÕES principais são permitidos —
    // ver WHITELIST_IDS[10] + NAME_RULES de "international friendlies").
    'club friendl', 'friendlies club', 'clubs? friendl',
    'amistos\\w* de clubes?', 'clube.*amistos', 'amistos.*clube',
    // Categorias de base / juvenis (U15..U23, Sub-15..Sub-23)
    '\\bu-?\\s?1[5-9]\\b', '\\bu-?\\s?2[0-3]\\b',
    '\\bsub-?\\s?1[5-9]\\b', '\\bsub-?\\s?2[0-3]\\b',
    'youth', 'juvenil', 'junior', 'j[uú]nior', 'primavera',
    // Times B / reservas / academias
    'reserve', 'reservas?', 'academy', '\\bb-?team\\b', '\\bteam b\\b', 'segunda b',
    // Feminino
    'women', 'femin', 'femen', 'f[eé]min', 'frauen', 'femmes',
    // Amador / baixa liquidez
    'amateur', 'amador',
    // NOTA: 2.Bundesliga e 3.Liga (alemãs) NÃO são excluídas — são ligas
    // profissionais adultas oferecidas pela Bet365 ao vivo. A exclusão antiga
    // existia só para evitar colisão de nome com a whitelist fixa (modo legado).
  ].join('|'),
  'i'
);

/* ============================================================
   WHITELIST por NOME — fallback.
   `re` casa contra `${name} ${country}` em lowercase.
   `country` (opcional) exige que o país também case (evita colisão
   de nomes genéricos como "Serie A", "Championship", "La Liga").
   `not` (opcional) rejeita variações indesejadas (ex.: 2ª divisão).
   ============================================================ */
const NAME_RULES = [
  // Continentais / internacionais (nome inequívoco, país livre)
  { re: /uefa champions league|\bchampions league\b/ },
  { re: /\beuropa league\b/ },
  { re: /(europa )?conference league/ },
  { re: /libertadores/ },
  { re: /sudamericana|sul-?americana/ },
  { re: /world cup|copa do mundo|copa del mundo/, not: /women|femin|u-?\d|sub-?\d|futsal|beach/ },
  { re: /euro(pean)? championship|eurocopa/, not: /u-?\d|sub-?\d|women|femin/ },
  { re: /copa am[eé]rica/, not: /femin|women/ },
  { re: /nations league/, not: /femin|women|concacaf nations league qualif/ },
  { re: /world cup.*qualif|qualif.*world cup|eliminat[óo]ri/, not: /femin|women|u-?\d/ },
  { re: /euro.*qualif|qualif.*euro/, not: /femin|women|u-?\d/ },
  // Amistosos de SELEÇÕES principais (International Friendlies). Bloqueia
  // explicitamente clube/base/reserva/feminino para passar só seleção principal.
  {
    re: /(international )?friendl|amistos/,
    country: /world|internacional|international/,
    not: /club|clube|u-?\d|sub-?\d|women|femin|youth|juvenil|reserve|olympic|ol[íi]mpic/,
  },

  // Ligas nacionais (país obrigatório para evitar colisão de nomes)
  { re: /premier league/, country: /england|inglaterra/ },
  { re: /championship/, country: /england|inglaterra/ },
  { re: /fa cup/, country: /england|inglaterra/ },
  { re: /la liga|primera divisi[oó]n|laliga/, country: /spain|espanha/, not: /femenina|women|hypermotion|smartbank/ },
  { re: /copa del rey/, country: /spain|espanha/ },
  { re: /serie a/, country: /italy|it[áa]lia/ },
  { re: /coppa italia/, country: /italy|it[áa]lia/ },
  { re: /bundesliga/, country: /germany|alemanha/, not: /2\.|3\.|frauen|women|u-?\d/ },
  { re: /ligue 1/, country: /france|fran[çc]a/ },
  { re: /eredivisie/, country: /netherlands|holanda|pa[íi]ses baixos/, not: /eerste/ },
  { re: /primeira liga|liga portugal/, country: /portugal/ },
  { re: /\bmls\b|major league soccer/, country: /usa|united states|estados unidos/ },
  { re: /liga mx|liga bbva mx/, country: /mexico|m[ée]xico/ },

  // Brasil (país obrigatório — "Série A/B" existe em vários países)
  { re: /s[ée]rie a/, country: /brazil|brasil/, not: /femin|women/ },
  { re: /s[ée]rie b/, country: /brazil|brasil/, not: /femin|women/ },
  { re: /copa do brasil/, country: /brazil|brasil/, not: /femin|women/ },
];

/* ============================================================
   NOMES "BONITOS" por ID — usados para exibir o nome completo da
   competição no painel (facilita identificar o jogo).
   ============================================================ */
const FRIENDLY_NAMES = {
  71: 'Brasileirão Série A',
  72: 'Brasileirão Série B',
  73: 'Copa do Brasil',
  13: 'CONMEBOL Libertadores',
  11: 'CONMEBOL Sul-Americana',
  39: 'Premier League (Inglaterra)',
  40: 'Championship (Inglaterra)',
  45: 'FA Cup (Inglaterra)',
  140: 'La Liga (Espanha)',
  143: 'Copa del Rey (Espanha)',
  135: 'Serie A (Itália)',
  137: 'Coppa Italia (Itália)',
  78: 'Bundesliga (Alemanha)',
  61: 'Ligue 1 (França)',
  88: 'Eredivisie (Holanda)',
  94: 'Primeira Liga (Portugal)',
  253: 'MLS (Estados Unidos)',
  262: 'Liga MX (México)',
  2: 'UEFA Champions League',
  3: 'UEFA Europa League',
  848: 'UEFA Conference League',
  1: 'Copa do Mundo',
  4: 'Eurocopa',
  9: 'Copa América',
  5: 'UEFA Nations League',
  10: 'Amistosos de Seleções',
  29: 'Eliminatórias da Copa (África)',
  30: 'Eliminatórias da Copa (Ásia)',
  31: 'Eliminatórias da Copa (CONCACAF)',
  32: 'Eliminatórias da Copa (Europa)',
  33: 'Eliminatórias da Copa (Oceania)',
  34: 'Eliminatórias da Copa (América do Sul)',
  960: 'Eliminatórias da Eurocopa',
};

/* ============================================================
   ESTADO RUNTIME — flag "somente ligas populares"
   ============================================================ */
const ENV_DEFAULT = String(process.env.SIGNALS_POPULAR_LEAGUES_ONLY ?? 'true')
  .toLowerCase() !== 'false';

/* ============================================================
   MODO DO FILTRO — exclude-only (default) vs whitelist (legado)
   ------------------------------------------------------------
   'exclude-only' (DEFAULT): com o filtro LIGADO, aceita QUALQUER liga
       adulta profissional ao vivo e bloqueia APENAS categorias não
       profissionais (base U15-U23, youth, reservas, times B, feminino,
       amador, amistosos de clubes — ver EXCLUDE_RX). É o comportamento
       "praticamente tudo que a Bet365 mostra ao vivo".
   'whitelist' (LEGADO): com o filtro LIGADO, só passam competições em
       WHITELIST_IDS / NAME_RULES (lista fixa).
   Override via env LEAGUE_FILTER_MODE.
   ============================================================ */
const FILTER_MODE = String(process.env.LEAGUE_FILTER_MODE || 'exclude-only')
  .toLowerCase().trim() === 'whitelist' ? 'whitelist' : 'exclude-only';

const PERSIST_PATH = path.join(__dirname, '..', '..', 'data', 'signal-filter.json');

function loadPersisted() {
  try {
    const raw = fs.readFileSync(PERSIST_PATH, 'utf8');
    const obj = JSON.parse(raw);
    if (typeof obj.popularOnly === 'boolean') return obj.popularOnly;
  } catch (_) { /* sem arquivo → usa env default */ }
  return ENV_DEFAULT;
}

function persist(value) {
  try {
    fs.mkdirSync(path.dirname(PERSIST_PATH), { recursive: true });
    fs.writeFileSync(PERSIST_PATH, JSON.stringify({ popularOnly: value, updatedAt: Date.now() }, null, 2));
  } catch (_) { /* best-effort — nunca quebrar por I/O */ }
}

let popularOnly = loadPersisted();

function isPopularOnly() { return popularOnly; }

function setPopularOnly(value) {
  popularOnly = !!value;
  persist(popularOnly);
  return popularOnly;
}

/* ============================================================
   MATCHERS
   ============================================================ */
function leagueHaystack(league) {
  if (!league) return '';
  return `${league.name || ''} ${league.country || ''}`.toLowerCase().trim();
}

function isExcluded(league) {
  return EXCLUDE_RX.test(leagueHaystack(league));
}

/** True se a liga pertence à whitelist (ID ou nome) e NÃO é excluída. */
function isWhitelisted(league) {
  if (!league) return false;
  if (isExcluded(league)) return false;

  const id = Number(league.id);
  if (Number.isFinite(id) && WHITELIST_IDS.has(id)) return true;

  const hay = leagueHaystack(league);
  const country = String(league.country || '').toLowerCase();
  for (const rule of NAME_RULES) {
    if (!rule.re.test(hay)) continue;
    if (rule.not && rule.not.test(hay)) continue;
    if (rule.country && !rule.country.test(country)) continue;
    return true;
  }
  return false;
}

/**
 * Gate principal usado por poller / engines / rotas.
 *
 * - Filtro DESLIGADO (popularOnly=false): passa TUDO, inclusive base/amador.
 * - Filtro LIGADO + modo 'exclude-only' (DEFAULT): passa qualquer liga adulta
 *   profissional; bloqueia SOMENTE categorias não-profissionais (EXCLUDE_RX:
 *   U15-U23, youth, reservas, times B, feminino, amador, amistosos de clubes).
 * - Filtro LIGADO + modo 'whitelist' (legado): só passa WHITELIST_IDS/NAME_RULES.
 */
function shouldAllow(match) {
  if (!popularOnly) return true;
  // Aceita tanto um match ({ league: {...} }) quanto um objeto league direto.
  // Só trata `match` como league se NÃO for claramente um match (sem home/away).
  let league = null;
  if (match) {
    if (match.league && typeof match.league === 'object') league = match.league;
    else if (match.home == null && match.away == null) league = match;
  }

  if (FILTER_MODE === 'whitelist') {
    if (!match) return false;
    return isWhitelisted(league);
  }

  // exclude-only: qualquer liga profissional adulta passa; só bloqueia as
  // categorias não-profissionais definidas em EXCLUDE_RX. Liga ausente é
  // tratada como não-excluída (não derruba jogo por metadado faltando).
  return !isExcluded(league);
}

/**
 * Nome completo da competição para exibição no painel.
 * Prioriza o nome "bonito" mapeado por ID; senão combina nome + país.
 */
function fullName(league) {
  if (!league) return '';
  const id = Number(league.id);
  if (Number.isFinite(id) && FRIENDLY_NAMES[id]) return FRIENDLY_NAMES[id];
  const name = String(league.name || '').trim();
  const country = String(league.country || '').trim();
  if (!name) return country || '';
  // Evita duplicar país quando já está no nome ou quando é competição mundial.
  if (!country || /world|international|uefa|conmebol|fifa/i.test(name)
      || name.toLowerCase().includes(country.toLowerCase())) {
    return name;
  }
  return `${name} (${country})`;
}

/** Lista legível das competições da whitelist (para o painel admin). */
function listWhitelist() {
  return [...WHITELIST_IDS].map((id) => ({ id, name: FRIENDLY_NAMES[id] || `Liga ${id}` }));
}

module.exports = {
  WHITELIST_IDS,
  isWhitelisted,
  isExcluded,
  shouldAllow,
  fullName,
  isPopularOnly,
  setPopularOnly,
  listWhitelist,
  envDefault: ENV_DEFAULT,
  filterMode: FILTER_MODE,
};
