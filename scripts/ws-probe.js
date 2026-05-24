const http = require('http');
const url = 'http://localhost:3010/socket.io/?EIO=4&transport=polling';
http.get(url, (res) => {
  let body=''; res.on('data', c => body+=c); res.on('end', () => {
    console.log('STATUS', res.statusCode);
    console.log('BODY', body.slice(0, 200));
  });
}).on('error', e => console.error('ERR', e.message));
