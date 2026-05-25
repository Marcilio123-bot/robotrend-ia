/**
 * Teste isolado da chave RapidAPI contra o host bet365data.p.rapidapi.com.
 *
 * Carrega .env automaticamente (chave fica fora do código-fonte).
 * Rode com:
 *     node test-sofascore.js
 */

'use strict';

require('dotenv').config(); // tenta carregar .env do diretório atual

const axios = require('axios');

const HOST = process.env.RAPIDAPI_HOST || 'bet365data.p.rapidapi.com';
const KEY  = process.env.RAPIDAPI_KEY;

if (!KEY) {
  console.error('❌ RAPIDAPI_KEY não encontrado. Defina no .env ou exporte no shell.');
  process.exit(1);
}

console.log(`🔑 chave: ${KEY.slice(0, 10)}…${KEY.slice(-4)} (len=${KEY.length})`);
console.log(`🌐 host:  ${HOST}`);
console.log(`📡 endpoint: https://${HOST}/live-events?sport=soccer\n`);

async function test() {
  const t0 = Date.now();
  try {
    const response = await axios.get(
      `https://${HOST}/live-events`,
      {
        params: { sport: 'soccer' },
        headers: {
          'x-rapidapi-key': KEY,
          'x-rapidapi-host': HOST,
          'Content-Type': 'application/json',
        },
        timeout: 15_000,
      }
    );

    const ms = Date.now() - t0;
    console.log(`✅ STATUS: ${response.status} (em ${ms}ms)`);

    const body = response.data;
    // Tentativa de extrair contagem em vários formatos possíveis
    const events = body?.events || body?.results || body?.data || body?.live_events || body;
    const count = Array.isArray(events) ? events.length
                : (events && typeof events === 'object') ? Object.keys(events).length
                : 0;
    console.log(`📊 TOTAL eventos/categorias: ${count}`);

    // Quota da RapidAPI (headers padrão)
    const quota = {
      limit:      response.headers['x-ratelimit-requests-limit'],
      remaining:  response.headers['x-ratelimit-requests-remaining'],
      reset:      response.headers['x-ratelimit-requests-reset'],
    };
    if (quota.limit) {
      console.log(`📈 quota: ${quota.remaining}/${quota.limit} restantes (reset em ${quota.reset}s)`);
    }

    // Imprime payload completo (pode ser grande — corta em ~10 KB para legibilidade)
    const json = JSON.stringify(body, null, 2);
    console.log('\n--- PAYLOAD ---');
    console.log(json.length > 10_000 ? json.slice(0, 10_000) + `\n... (truncado, total ${json.length} chars) ...` : json);
  } catch (err) {
    const ms = Date.now() - t0;
    console.log(`❌ ERRO em ${ms}ms`);
    if (err.response) {
      console.log(`  STATUS: ${err.response.status}`);
      console.log(`  HEADERS:`, {
        'content-type': err.response.headers['content-type'],
        'x-ratelimit-requests-remaining': err.response.headers['x-ratelimit-requests-remaining'],
      });
      console.log(`  BODY:`, err.response.data);
    } else if (err.code) {
      console.log(`  CODE: ${err.code} — ${err.message}`);
    } else {
      console.log(`  ${err.message}`);
    }
    process.exitCode = 1;
  }
}

test();
