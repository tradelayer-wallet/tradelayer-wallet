const path = require('path');

const { initLoclaServer } = require(path.join(__dirname, '..', 'dist', 'server', 'index.js'));

const server = initLoclaServer(() => {
  console.log('[wallet-api] safe close requested');
  process.exit(0);
});

server.start();

console.log('[wallet-api] listening on http://127.0.0.1:1986');

setInterval(() => {}, 1 << 30);
