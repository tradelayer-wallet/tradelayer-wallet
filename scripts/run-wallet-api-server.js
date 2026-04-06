const path = require('path');

const { initLoclaServer } = require(path.join(__dirname, '..', 'dist', 'server', 'index.js'));
const host = process.env.WALLET_API_HOST || '127.0.0.1';
const port = process.env.WALLET_API_PORT || '1986';

const server = initLoclaServer(() => {
  console.log('[wallet-api] safe close requested');
  process.exit(0);
});

server.start();

console.log(`[wallet-api] listening on http://${host}:${port}`);

setInterval(() => {}, 1 << 30);
