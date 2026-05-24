'use strict';
const crypto = require('crypto');
const out = {
  JWT_SECRET: crypto.randomBytes(64).toString('hex'),
  SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
  POSTGRES_PASSWORD: crypto.randomBytes(24).toString('base64url').slice(0, 32),
};
console.log(JSON.stringify(out, null, 2));
