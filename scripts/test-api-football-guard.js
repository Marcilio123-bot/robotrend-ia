#!/usr/bin/env node
'use strict';
/**
 * Smoke: apiFootball NÃO deve abrir socket HTTP sem API_FOOTBALL_KEY válida.
 */
const http = require('http');
const https = require('https');

let sockets = 0;
const origHttp = http.request;
const origHttps = https.request;
http.request = function (...args) { sockets++; return origHttp.apply(this, args); };
https.request = function (...args) { sockets++; return origHttps.apply(this, args); };

delete process.env.API_FOOTBALL_KEY;
delete require.cache[require.resolve('../backend/services/apiFootball')];

const af = require('../backend/services/apiFootball');

async function run() {
  const s0 = sockets;
  const st = af.status();
  const live = await af.getLiveFixtures();
  const s1 = sockets;

  const ok =
    st.configured === false &&
    st.keyValid === false &&
    Array.isArray(live) && live.length === 0 &&
    live.__skipped === true &&
    s1 === s0;

  console.log(JSON.stringify({
    ok,
    configured: st.configured,
    keyValid: st.keyValid,
    liveLen: live.length,
    skipped: live.__skipped,
    socketsBefore: s0,
    socketsAfter: s1,
  }, null, 2));
  process.exit(ok ? 0 : 1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
