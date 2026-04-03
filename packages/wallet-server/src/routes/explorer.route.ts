import { FastifyInstance } from 'fastify';
import { fasitfyServer } from '../index';
import { explorerService } from '../services/explorer.service';

function htmlPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Layer Explorer</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b0f14;
      --panel: #121824;
      --panel-2: #171f2d;
      --line: #263248;
      --text: #e8eef7;
      --muted: #8fa3bf;
      --accent: #57b2ff;
      --accent-2: #8ef0c1;
      --warn: #ffcb6b;
      --danger: #ff7b72;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at top left, rgba(87,178,255,0.12), transparent 30%),
        radial-gradient(circle at top right, rgba(142,240,193,0.08), transparent 28%),
        var(--bg);
      color: var(--text);
    }
    header {
      padding: 32px 24px 16px;
      border-bottom: 1px solid var(--line);
      backdrop-filter: blur(10px);
      position: sticky;
      top: 0;
      background: rgba(11, 15, 20, 0.86);
      z-index: 5;
    }
    h1 { margin: 0; font-size: 30px; letter-spacing: -0.03em; }
    .sub { color: var(--muted); margin-top: 6px; }
    main { padding: 24px; display: grid; gap: 18px; max-width: 1500px; margin: 0 auto; }
    .grid {
      display: grid;
      gap: 18px;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    }
    .card {
      border: 1px solid var(--line);
      background: linear-gradient(180deg, rgba(18,24,36,0.96), rgba(18,24,36,0.84));
      border-radius: 18px;
      padding: 18px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.25);
    }
    .card h2, .card h3 { margin: 0 0 12px; }
    .kpi {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
      gap: 12px;
    }
    .kpi > div, .pill, .row {
      border: 1px solid var(--line);
      border-radius: 14px;
      background: rgba(23,31,45,0.92);
      padding: 12px;
    }
    .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
    .value { font-size: 18px; margin-top: 4px; overflow-wrap: anywhere; }
    .pill { display: inline-flex; flex-direction: column; gap: 4px; margin: 0 10px 10px 0; min-width: 180px; }
    input, button, textarea {
      width: 100%;
      border-radius: 12px;
      border: 1px solid var(--line);
      background: #0f1520;
      color: var(--text);
      padding: 12px 14px;
      font: inherit;
    }
    button {
      background: linear-gradient(135deg, var(--accent), #436bff);
      font-weight: 600;
      cursor: pointer;
    }
    button.secondary {
      background: linear-gradient(135deg, #243044, #1a2435);
    }
    .controls {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 12px;
      align-items: end;
    }
    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 12px;
      line-height: 1.4;
      background: #090d13;
      color: #d8e3f3;
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 14px;
      overflow: auto;
      max-height: 500px;
    }
    .muted { color: var(--muted); }
    .danger { color: var(--danger); }
    .warn { color: var(--warn); }
    .ok { color: var(--accent-2); }
    .table {
      display: grid;
      gap: 8px;
    }
    .table-row {
      display: grid;
      grid-template-columns: 120px 1fr;
      gap: 8px;
      border-bottom: 1px solid rgba(38,50,72,0.6);
      padding-bottom: 8px;
    }
    .table-row:last-child { border-bottom: 0; padding-bottom: 0; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    details summary { cursor: pointer; color: var(--accent); }
    .graph {
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: #0b1018;
      padding: 12px;
    }
    #result, #bitvmReport, #graphWrap { margin-top: 12px; }
    .split {
      display: grid;
      grid-template-columns: 1.1fr 0.9fr;
      gap: 18px;
    }
    @media (max-width: 1100px) {
      .split { grid-template-columns: 1fr; }
    }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
</head>
<body>
  <header>
    <h1>Layer Explorer</h1>
    <div class="sub">TradeLayer + BitVM/DLC state explorer. Read-only. Built for chain, oracle, and receipt inspection.</div>
  </header>
  <main>
    <section class="grid" id="overview"></section>

    <section class="split">
      <div class="card">
        <h2>Lookup</h2>
        <div class="controls">
          <label>
            <div class="label">Address</div>
            <input id="addrInput" placeholder="tltc1..." />
          </label>
          <label>
            <div class="label">Property ID</div>
            <input id="propInput" placeholder="73" />
          </label>
          <label>
            <div class="label">TxID</div>
            <input id="txInput" placeholder="..." />
          </label>
          <button onclick="lookupAddress()">Inspect Address</button>
          <button onclick="lookupProperty()">Inspect Property</button>
          <button onclick="lookupTx()">Inspect Tx</button>
        </div>
        <div id="result"></div>
      </div>

      <div class="card">
        <h2>BitVM Report</h2>
        <div class="muted">Circuit stats, route branches, and artifact anchors from UTXORef.</div>
        <div id="bitvmReport"></div>
      </div>
    </section>

    <section class="card">
      <h2>BitVM Graph</h2>
      <div class="muted">Wallet UTXOs, bootstrap, PSBT/CET, oracle, roll-forward, ledger, transition, referee.</div>
      <div class="graph" id="graphWrap">
        <div class="mermaid" id="graphText"></div>
      </div>
    </section>
  </main>

  <script>
    const pretty = (value) => JSON.stringify(value, null, 2);
    const el = (id) => document.getElementById(id);

    async function api(path) {
      const res = await fetch(path);
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    }

    async function loadOverview() {
      const data = await api('/explorer/api/overview');
      const sync = data.sync || {};
      const rows = [
        ['Chain', data.chainInfo?.chain || 'unknown'],
        ['Blocks', data.chainInfo?.blocks ?? 'n/a'],
        ['Headers', data.chainInfo?.headers ?? 'n/a'],
        ['Sync', sync?.consensus ? (sync.consensus + ' / ' + (sync.maxProcessed || sync.txIndex || 'n/a')) : (sync?.error || 'n/a')],
        ['Properties', Array.isArray(data.properties) ? data.properties.length : 0],
        ['BitVM gates', data.bitvm?.circuits?.referee?.totalGates ?? 'n/a'],
        ['Transition gates', data.bitvm?.circuits?.transition?.totalGates ?? 'n/a']
      ];

      el('overview').innerHTML = rows.map(([label, value]) =>
        '<div class="pill">' +
          '<div class="label">' + label + '</div>' +
          '<div class="value">' + String(value) + '</div>' +
        '</div>').join('');

      el('bitvmReport').innerHTML =
        '<div class="table">' +
          '<div class="table-row"><div class="label">Template</div><div class="mono">' + (data.bitvm?.template?.templateId || 'n/a') + '</div></div>' +
          '<div class="table-row"><div class="label">Template hash</div><div class="mono">' + (data.bitvm?.template?.templateHash || 'n/a') + '</div></div>' +
          '<div class="table-row"><div class="label">Referee gates</div><div>' + (data.bitvm?.circuits?.referee?.totalGates ?? 'n/a') + ' (free ' + (data.bitvm?.circuits?.referee?.freeGates ?? 'n/a') + ', non-free ' + (data.bitvm?.circuits?.referee?.nonFreeGates ?? 'n/a') + ')</div></div>' +
          '<div class="table-row"><div class="label">Transition gates</div><div>' + (data.bitvm?.circuits?.transition?.totalGates ?? 'n/a') + ' (free ' + (data.bitvm?.circuits?.transition?.freeGates ?? 'n/a') + ', non-free ' + (data.bitvm?.circuits?.transition?.nonFreeGates ?? 'n/a') + ')</div></div>' +
          '<div class="table-row"><div class="label">Latest report hash</div><div class="mono">' + (data.bitvm?.reportHash || 'n/a') + '</div></div>' +
        '</div>' +
        '<details style="margin-top:12px">' +
          '<summary>Latest artifacts</summary>' +
          '<pre>' + pretty(data.artifacts || {}) + '</pre>' +
        '</details>';

      const mermaidText = data.bitvm?.flow?.mermaid || 'graph TD\\n  empty[No BitVM report found]';
      el('graphText').textContent = mermaidText;
      if (window.mermaid) {
        window.mermaid.initialize({ startOnLoad: false, theme: 'dark' });
        try {
          window.mermaid.init(undefined, '#graphText');
        } catch (e) {
          console.warn(e);
        }
      }
    }

    async function lookupAddress() {
      const address = el('addrInput').value.trim();
      if (!address) return;
      const data = await api('/explorer/api/address/' + encodeURIComponent(address));
      el('result').innerHTML = '<pre>' + pretty(data) + '</pre>';
    }

    async function lookupProperty() {
      const id = el('propInput').value.trim();
      if (!id) return;
      const data = await api('/explorer/api/property/' + encodeURIComponent(id));
      el('result').innerHTML = '<pre>' + pretty(data) + '</pre>';
    }

    async function lookupTx() {
      const txid = el('txInput').value.trim();
      if (!txid) return;
      const data = await api('/explorer/api/tx/' + encodeURIComponent(txid));
      el('result').innerHTML = '<pre>' + pretty(data) + '</pre>';
    }

    loadOverview().catch(err => {
      el('overview').innerHTML = '<div class="card danger">Explorer failed to load overview: ' + String(err.message || err) + '</div>';
    });
  </script>
</body>
</html>`;
}

export const explorerRoutes = (fastify: FastifyInstance, _opts: any, done: any) => {
  fastify.get('/', async (_request, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8').send(htmlPage());
  });

  fastify.get('/api/overview', async (_request, reply) => {
    try {
      const data = await explorerService.getOverview(fasitfyServer.rpcClient);
      reply.send(data);
    } catch (error: any) {
      reply.status(500).send({ error: error?.message || error || 'Undefined Error' });
    }
  });

  fastify.get('/api/address/:address', async (request, reply) => {
    try {
      const { address } = request.params as { address: string };
      const data = await explorerService.getAddressSnapshot(address);
      reply.send(data);
    } catch (error: any) {
      reply.status(500).send({ error: error?.message || error || 'Undefined Error' });
    }
  });

  fastify.get('/api/property/:propertyId', async (request, reply) => {
    try {
      const { propertyId } = request.params as { propertyId: string };
      const data = await explorerService.getPropertySnapshot(Number(propertyId));
      reply.send(data);
    } catch (error: any) {
      reply.status(500).send({ error: error?.message || error || 'Undefined Error' });
    }
  });

  fastify.get('/api/tx/:txid', async (request, reply) => {
    try {
      const { txid } = request.params as { txid: string };
      const data = await explorerService.getTxSnapshot(txid, fasitfyServer.rpcClient);
      reply.send(data);
    } catch (error: any) {
      reply.status(500).send({ error: error?.message || error || 'Undefined Error' });
    }
  });

  fastify.get('/api/bitvm/report', async (_request, reply) => {
    try {
      reply.send(await explorerService.getBitvmReport());
    } catch (error: any) {
      reply.status(500).send({ error: error?.message || error || 'Undefined Error' });
    }
  });

  fastify.get('/api/artifacts', async (_request, reply) => {
    try {
      reply.send(await explorerService.listArtifacts());
    } catch (error: any) {
      reply.status(500).send({ error: error?.message || error || 'Undefined Error' });
    }
  });

  fastify.get('/api/artifact/:name', async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      reply.send(await explorerService.getArtifact(name));
    } catch (error: any) {
      reply.status(500).send({ error: error?.message || error || 'Undefined Error' });
    }
  });

  fastify.get('/api/address/:address/history', async (request, reply) => {
    try {
      const { address } = request.params as { address: string };
      reply.send(await explorerService.getAddressHistory(address));
    } catch (error: any) {
      reply.status(500).send({ error: error?.message || error || 'Undefined Error' });
    }
  });

  fastify.get('/api/contract/:contractId/history', async (request, reply) => {
    try {
      const { contractId } = request.params as { contractId: string };
      reply.send(await explorerService.getContractHistory(Number(contractId)));
    } catch (error: any) {
      reply.status(500).send({ error: error?.message || error || 'Undefined Error' });
    }
  });

  done();
};
