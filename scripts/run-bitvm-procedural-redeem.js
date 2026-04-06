const http = require('http');

function postHttpJson(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const target = new URL(url);
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(JSON.parse(raw));
        } catch (error) {
          reject(new Error(`Invalid JSON response (${res.statusCode}): ${raw}`));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function rpcJson(url, method, params, auth) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      jsonrpc: '1.0',
      id: 'codex',
      method,
      params: params || []
    });
    const target = new URL(url);
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Authorization: `Basic ${Buffer.from(auth).toString('base64')}`
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          const parsed = JSON.parse(raw);
          if (parsed.error) {
            reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
            return;
          }
          resolve(parsed.result);
        } catch (error) {
          reject(new Error(`Invalid RPC response (${res.statusCode}): ${raw}`));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function encodeRedeemManagedToken({ propertyId, amount, templateId, contractId }) {
  const sats = Math.round(Number(amount || 0) * 1e8);
  return 'tl' + (12).toString(36) + [
    Number(propertyId).toString(36),
    sats.toString(36),
    String(templateId || ''),
    String(contractId || '').split(':', 1)[0],
    'SETTLED'
  ].join(',');
}

async function main() {
  const walletApi = process.env.WALLET_API_URL || 'http://127.0.0.1:1986';
  const syncRes = await postHttpJson(`${walletApi}/api/bitvm/sync-procedural`, {});
  const sync = syncRes?.data;
  if (!sync) {
    throw new Error('Sync route returned no data.');
  }

  const payload = encodeRedeemManagedToken({
    propertyId: sync.propertyId,
    amount: sync.fundedAmountLtc,
    templateId: sync.templateId,
    contractId: sync.contractId
  });

  const buildRes = await postHttpJson(`${walletApi}/api/build-tx`, {
    fromKeyPair: { address: sync.holderAddress },
    toKeyPair: { address: sync.holderAddress },
    payload,
    network: 'LTCTEST'
  });
  if (buildRes?.error || !buildRes?.data?.rawtx) {
    throw new Error(buildRes?.error || 'Failed to build redeem tx.');
  }

  const rpcAuth = `${process.env.LTC_RPC_USER || 'user'}:${process.env.LTC_RPC_PASS || 'pass'}`;
  const walletName = process.env.LTC_WALLET_NAME || 'tl-wallet';
  const walletRpc = process.env.LTC_WALLET_RPC_URL || `http://127.0.0.1:19332/wallet/${walletName}`;

  const signResult = await rpcJson(walletRpc, 'signrawtransactionwithwallet', [buildRes.data.rawtx], rpcAuth);
  if (!signResult?.complete || !signResult?.hex) {
    throw new Error('Wallet failed to fully sign the redeem tx.');
  }

  const txid = await rpcJson(walletRpc, 'sendrawtransaction', [signResult.hex], rpcAuth);
  console.log(JSON.stringify({
    holderAddress: sync.holderAddress,
    propertyId: sync.propertyId,
    amountLtc: sync.fundedAmountLtc,
    contractId: sync.contractId,
    redeemTxid: txid
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
