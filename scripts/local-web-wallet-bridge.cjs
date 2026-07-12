#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');
const fetch = require('node-fetch');
const WS = require('ws');

const repoRoot = path.resolve(__dirname, '..');
const envPath = path.join(repoRoot, '.env');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key && process.env[key] == null) process.env[key] = value;
  }
}

function parseConf(datadir) {
  const confPath = path.join(datadir, 'litecoin.conf');
  const out = {};
  if (!fs.existsSync(confPath)) return out;
  for (const line of fs.readFileSync(confPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('[')) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 0) continue;
    out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return out;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function writeJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json');
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.end(JSON.stringify(body));
}

loadEnvFile(envPath);

const datadir = process.env.DATADIR || path.join(process.env.USERPROFILE || repoRoot, 'AppData', 'Roaming', 'Litecoin');
const conf = parseConf(datadir);
const rpcUser = process.env.RPC_USER || conf.rpcuser;
const rpcPass = process.env.RPC_PASS || conf.rpcpassword;
const rpcHost = process.env.RPC_HOST || conf.rpchost || '127.0.0.1';
const rpcPort = Number(process.env.RPC_PORT || conf.rpcport || 19332);
const walletName = process.env.RPC_WALLET_NAME || process.env.WALLET_LABEL || 'tl-wallet';
const port = Number(process.env.TL_WEB_WALLET_BRIDGE_PORT || 1986);

async function rpc(method, params = [], wallet = walletName) {
  if (!rpcUser || !rpcPass) throw new Error(`Missing RPC credentials in ${path.join(datadir, 'litecoin.conf')}`);
  const walletPath = wallet ? `/wallet/${encodeURIComponent(wallet)}` : '';
  const response = await fetch(`http://${rpcHost}:${rpcPort}${walletPath}`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${rpcUser}:${rpcPass}`).toString('base64')}`,
      'content-type': 'text/plain',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json?.error?.message || `RPC HTTP ${response.status}`);
  if (json?.error) throw new Error(json.error.message || JSON.stringify(json.error));
  return json.result;
}

async function ensureWallet() {
  const wallets = await rpc('listwallets', [], '');
  if (Array.isArray(wallets) && wallets.includes(walletName)) return;
  try {
    await rpc('loadwallet', [walletName], '');
  } catch (error) {
    const msg = String(error?.message || error);
    if (!msg.includes('already loaded')) throw error;
  }
}

async function ensurePubkey(pubkey) {
  const normalized = String(pubkey || '').trim();
  if (!normalized) return { imported: false };
  await ensureWallet();
  try {
    await rpc('importpubkey', [normalized, 'tl-web-watchonly', false]);
    return { imported: true };
  } catch (error) {
    const msg = String(error?.message || error).toLowerCase();
    if (msg.includes('already') || msg.includes('exists')) return { imported: false, alreadyImported: true };
    throw error;
  }
}

async function handleApi(method, pathname, body) {
  const validate = pathname.match(/^\/address\/validate\/(.+)$/);
  if (method === 'GET' && validate) {
    return { data: await rpc('validateaddress', [decodeURIComponent(validate[1])]) };
  }

  const utxo = pathname.match(/^\/address\/utxo\/(.+)$/);
  if (method === 'POST' && utxo) {
    const address = decodeURIComponent(utxo[1]);
    await ensurePubkey(body?.pubkey);
    const rows = await rpc('listunspent', [0, 999999999, [address]]);
    return (Array.isArray(rows) ? rows : []).map((row) => ({
      txid: row.txid,
      vout: row.vout,
      address: row.address,
      amount: Number(row.amount || 0),
      confirmations: Number(row.confirmations || 0),
      scriptPubKey: row.scriptPubKey,
      spendable: !!row.spendable,
      solvable: !!row.solvable,
      safe: row.safe !== false,
    }));
  }

  if (method === 'POST' && pathname === '/address/sync-watchonly') {
    const accounts = Array.isArray(body?.accounts) ? body.accounts : [];
    const results = [];
    for (const account of accounts) {
      const address = String(account?.address || '').trim();
      const pubkey = String(account?.pubkey || '').trim();
      try {
        const result = await ensurePubkey(pubkey);
        results.push({ address, pubkey, ...result });
      } catch (error) {
        results.push({ address, pubkey, imported: false, error: error?.message || String(error) });
      }
    }
    return {
      imported: results.filter((row) => row.imported).length,
      skipped: results.filter((row) => !row.imported).length,
      results,
    };
  }

  const rpcMatch = pathname.match(/^\/rpc\/([^/]+)$/);
  if (method === 'POST' && rpcMatch) {
    return { data: await rpc(decodeURIComponent(rpcMatch[1]), Array.isArray(body?.params) ? body.params : []) };
  }

  throw Object.assign(new Error(`No route for ${method} ${pathname}`), { statusCode: 404 });
}

const server = http.createServer((req, res) => {
  void (async () => {
    if (req.method === 'OPTIONS') {
      writeJson(res, 204, {});
      return;
    }
    const u = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const body = req.method === 'GET' ? {} : await readJson(req);
    const data = await handleApi(req.method || 'GET', u.pathname, body);
    writeJson(res, 200, data);
  })().catch((error) => writeJson(res, error?.statusCode || 500, { error: error?.message || String(error) }));
});

const wss = new WS.Server({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  if (!u.pathname.startsWith('/ws')) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.send(JSON.stringify({ event: 'connected', boundPath: '/' }));
    ws.on('message', async (raw) => {
      let payload;
      try {
        payload = JSON.parse(String(raw));
        const data = await handleApi(
          String(payload.method || (payload.body ? 'POST' : 'GET')).toUpperCase(),
          String(payload.path || '/'),
          payload.body || {}
        );
        ws.send(JSON.stringify({ id: payload.id, ok: true, statusCode: 200, data }));
      } catch (error) {
        ws.send(JSON.stringify({
          id: payload?.id,
          ok: false,
          statusCode: error?.statusCode || 500,
          error: error?.message || String(error),
        }));
      }
    });
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ ok: true, port, datadir, rpcHost, rpcPort, walletName }, null, 2));
});
