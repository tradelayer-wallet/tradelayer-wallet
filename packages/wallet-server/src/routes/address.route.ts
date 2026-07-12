import { FastifyInstance } from 'fastify';
import { proxyWalletMethod } from '../services/rpc-proxy.service';

const WATCHONLY_LABEL = 'tl-web-watchonly';

function normalizeParams(body: any): any[] {
  if (Array.isArray(body?.params)) return body.params;
  if (body?.params == null) return [];
  return [body.params];
}

function isAlreadyImportedError(error: any) {
  const msg = String(error || '').toLowerCase();
  return msg.includes('already') || msg.includes('exists') || msg.includes('duplicate');
}

async function walletRpc(method: string, params: any[], walletName?: string) {
  const body: any = { params };
  if (walletName) body.walletName = walletName;
  return proxyWalletMethod(method, body);
}

async function ensureWatchOnlyPubkey(pubkey?: string, walletName?: string) {
  const normalized = String(pubkey || '').trim();
  if (!normalized) return { imported: false };

  const res = await walletRpc('importpubkey', [normalized, WATCHONLY_LABEL, false], walletName);
  if (res?.error && !isAlreadyImportedError(res.error)) {
    throw new Error(res.error);
  }
  return { imported: !res?.error, alreadyImported: !!res?.error };
}

function normalizeUtxo(raw: any) {
  return {
    txid: raw?.txid,
    vout: raw?.vout,
    address: raw?.address,
    amount: Number(raw?.amount || 0),
    confirmations: Number(raw?.confirmations || 0),
    scriptPubKey: raw?.scriptPubKey,
    spendable: !!raw?.spendable,
    solvable: !!raw?.solvable,
    safe: raw?.safe !== false,
  };
}

export const addressRoute = (fastify: FastifyInstance, _opts: any, done: any) => {
  fastify.get('/validate/:address', async (request, reply) => {
    try {
      const { address } = request.params as { address: string };
      const walletName = String((request.query as any)?.walletName || '').trim() || undefined;
      const res = await walletRpc('validateaddress', [address], walletName);
      if (res?.error) {
        reply.status(400).send({ error: res.error });
        return;
      }
      reply.send({ data: res.data });
    } catch (error: any) {
      reply.status(500).send({ error: error?.message || error || 'Undefined Error' });
    }
  });

  fastify.post('/sync-watchonly', async (request, reply) => {
    try {
      const body = (request.body || {}) as {
        accounts?: Array<{ address?: string; pubkey?: string }>;
        walletName?: string;
      };
      const walletName = String(body.walletName || '').trim() || undefined;
      const accounts = Array.isArray(body.accounts) ? body.accounts : [];
      console.log('[watchonly] sync request', {
        walletName: walletName || '(default)',
        accounts: accounts.length,
      });
      let imported = 0;
      let skipped = 0;
      const results = [];

      for (const account of accounts) {
        const address = String(account?.address || '').trim();
        const pubkey = String(account?.pubkey || '').trim();
        console.log('[watchonly] import attempt', {
          walletName: walletName || '(default)',
          address,
          hasPubkey: !!pubkey,
        });
        if (!address || !pubkey) {
          skipped += 1;
          results.push({ address, imported: false, error: 'Missing address or pubkey' });
          continue;
        }

        try {
          const res = await ensureWatchOnlyPubkey(pubkey, walletName);
          imported += res.imported ? 1 : 0;
          skipped += res.imported ? 0 : 1;
          results.push({ address, pubkey, imported: res.imported, alreadyImported: !!res.alreadyImported });
        } catch (error: any) {
          skipped += 1;
          results.push({ address, pubkey, imported: false, error: error?.message || String(error) });
        }
      }

      reply.send({ imported, skipped, results });
    } catch (error: any) {
      reply.status(500).send({ error: error?.message || error || 'Undefined Error' });
    }
  });

  fastify.post('/utxo/:address', async (request, reply) => {
    try {
      const { address } = request.params as { address: string };
      const body = (request.body || {}) as { pubkey?: string; walletName?: string };
      const walletName = String(body.walletName || '').trim() || undefined;
      console.log('[watchonly] utxo request', {
        walletName: walletName || '(default)',
        address,
        hasPubkey: !!String(body.pubkey || '').trim(),
      });
      await ensureWatchOnlyPubkey(body.pubkey, walletName);

      const res = await walletRpc('listunspent', [0, 999999999, [address]], walletName);
      if (res?.error) {
        reply.status(400).send({ error: res.error });
        return;
      }

      const utxos = Array.isArray(res?.data) ? res.data.map(normalizeUtxo) : [];
      reply.send(utxos);
    } catch (error: any) {
      reply.status(500).send({ error: error?.message || error || 'Undefined Error' });
    }
  });

  fastify.get('/balance/:address', async (request, reply) => {
    try {
      const { address } = request.params as { address: string };
      const walletName = String((request.query as any)?.walletName || '').trim() || undefined;
      console.log('[watchonly] token balance request', {
        walletName: walletName || '(default)',
        address,
      });
      const res = await walletRpc('tl_getallbalancesforaddress', [address], walletName);
      if (res?.error) {
        reply.status(400).send({ error: res.error });
        return;
      }
      reply.send(Array.isArray(res?.data) ? res.data : []);
    } catch (error: any) {
      reply.status(500).send({ error: error?.message || error || 'Undefined Error' });
    }
  });

  fastify.get('/faucet/:address', async (_request, reply) => {
    reply.status(400).send({ error: 'Local desktop wallet does not provide a faucet' });
  });

  done();
};
