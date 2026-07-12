const http = require('http');
const https = require('https');

const baseUrl = String(process.env.TL_WALLET_SERVER_URL || process.argv[2] || 'http://127.0.0.1:4200')
  .replace(/\/+$/, '');
const target = `${baseUrl}/explorer/api/bitvm/contracts`;

function getJson(url) {
  const transport = url.startsWith('https:') ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = body ? JSON.parse(body) : null;
        } catch (error) {
          reject(new Error(`Invalid JSON from ${url}: ${error.message}`));
          return;
        }
        resolve({ statusCode: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy(new Error(`Timed out calling ${url}`));
    });
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

(async () => {
  const { statusCode, body } = await getJson(target);
  assert(statusCode === 200, `Expected HTTP 200, got ${statusCode}`);
  assert(body && typeof body === 'object', 'Expected JSON object response');
  assert(Array.isArray(body.contracts), 'Expected contracts array');
  assert(Number.isFinite(Number(body.depositedContractCount)), 'Expected depositedContractCount number');
  assert(Number.isFinite(Number(body.withdrawnContractCount)), 'Expected withdrawnContractCount number');

  if (body.contracts.length) {
    const first = body.contracts[0];
    [
      'contractId',
      'templateId',
      'chain',
      'fundingTxid',
      'depositSats',
      'withdrawnSats',
      'rolloverSats',
      'maturityHeight',
      'rollLocktime',
      'blocksToRoll',
    ].forEach((field) => assert(first[field] !== undefined, `Expected contract field ${field}`));
  }

  console.log(JSON.stringify({
    ok: true,
    url: target,
    depositedContractCount: body.depositedContractCount,
    withdrawnContractCount: body.withdrawnContractCount,
    totalDepositedSats: body.totalDepositedSats,
    totalWithdrawnSats: body.totalWithdrawnSats,
    contractCount: body.contracts.length,
  }, null, 2));
})().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
