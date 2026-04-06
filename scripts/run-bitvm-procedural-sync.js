const http = require('http');

function postJson(url, body) {
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

async function main() {
  const apiUrl = process.env.WALLET_API_URL || 'http://127.0.0.1:1986/api/bitvm/sync-procedural';
  const holderAddress = process.env.BITVM_HOLDER_ADDRESS || '';
  const state = process.env.BITVM_PROCEDURAL_STATE || 'SETTLED';
  const response = await postJson(apiUrl, {
    holderAddress: holderAddress || undefined,
    state
  });
  console.log(JSON.stringify(response, null, 2));
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
