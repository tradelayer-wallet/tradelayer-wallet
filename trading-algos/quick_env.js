// runAlgo.js
require('dotenv').config(); // optional: reads .env if present

const ApiWrapper = require('./algoAPI.js');

const toBool = (v, d=false) =>
  v === undefined ? d :
  ['1','true','yes','on'].includes(String(v).trim().toLowerCase());

const required = (name, def) => {
  const v = process.env[name] ?? def;
  if (v === undefined || v === '') {
    throw new Error(`Missing required env: ${name}`);
  }
  return v;
};

// ---- ENV CONFIG ----
const HOST     = required('TL_HOST', 'ws://172.26.37.103'); // includes ws://
const PORT     = Number(process.env.TL_PORT ?? 3001);
const TESTNET  = toBool(process.env.TL_TEST, true);          // true | false
const TL_ON    = toBool(process.env.TL_TLON, true);          // your "tlAlreadyOn"
const ADDRESS  = required('TL_ADDRESS', 'tltc1qn006lvcx89zjnhuzdmj0rjcwnfuqn7eycw40yf');
const PUBKEY   = required('TL_PUBKEY',  '03670d8f2109ea83ad09142839a55c77a6f044dab8cb8724949931ae8ab1316677');
const NETWORK  = required('TL_NETWORK', 'LTCTEST');          // e.g., LTCTEST | BTCTEST | LTC

// ---- INIT ----
const api = new ApiWrapper(HOST, PORT, TESTNET, TL_ON, ADDRESS, PUBKEY, NETWORK);

(async () => {
  console.log('[cfg]', { HOST, PORT, TESTNET, TL_ON, ADDRESS, NETWORK });

  await api.delay(1500);

  const me = api.getMyInfo();
  console.log('me:', me.address);

  const spot = await api.getSpotMarkets();
  console.log('spot:', Array.isArray(spot) ? spot.length : 0);

  const ob = await api.getOrderbookData({ type: 'SPOT', first_token: 0, second_token: 5 });
  console.log('orderbook levels:', { bids: ob?.bids?.length || 0, asks: ob?.asks?.length || 0 });

  const order = {
    type: 'SPOT',
    action: 'SELL',
    isLimitOrder: true,
    keypair: { address: ADDRESS, pubkey: PUBKEY },
    props: { id_for_sale: 0, id_desired: 5, price: 100, amount: 0.1, transfer: false }
  };

  const uuid = await api.sendOrder(order);
  console.log('order sent:', uuid);
})().catch(e => {
  console.error('[fatal]', e);
  process.exit(1);
});
