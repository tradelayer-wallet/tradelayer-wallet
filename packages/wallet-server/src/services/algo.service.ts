import { FastifyReply, FastifyRequest } from 'fastify';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { ProcessDescription } from 'pm2';
import { v4 as uuidv4 } from 'uuid';
import * as os from 'os';

let _pm2: any;
function pm2() {
  // use eval('require') so webpack doesn't try to bundle pm2
  if (!_pm2) _pm2 = (eval('require') as NodeRequire)('pm2');
  return _pm2;
}

// Where defaults live at runtime:
// 1) allow override via env
// 2) else use electron resourcesPath
// 3) fallback to dev path (ts-node / node ./dist)
const RESOURCES = (process as any).resourcesPath || path.join(__dirname, '..', '..');
const DEFAULTS_DIR =
  process.env.ALGO_DEFAULTS_DIR ||
  path.join(RESOURCES, 'assets', 'algo-defaults');
const safeName = (s: string) => s.replace(/[^a-z0-9_\-\.]/gi, '_');

/**
 * Bootstrap the user's algo folder with defaults exactly once.
 * - If the user folder already has any *.js, we do nothing.
 * - If not, we copy from DEFAULTS_DIR and rebuild the index.
 */
export async function bootstrapAlgoAssets(): Promise<void> {
  try {
    await ensureIndexFile(); // your existing helper

    // If user folder already has .js, skip
    const existing = await fsp.readdir(baseDir).catch(() => []);
    const hasJs = existing.some(f => f.toLowerCase().endsWith('.js'));
    if (hasJs) {
      console.log('[algo.defaults] user folder already has scripts — skipping bootstrap');
      return;
    }

    // Check defaults folder
    const defaultsOk = await fsp
      .access(DEFAULTS_DIR)
      .then(() => true)
      .catch(() => false);

    if (!defaultsOk) {
      console.warn('[algo.defaults] no defaults at', DEFAULTS_DIR, '(set ALGO_DEFAULTS_DIR to override)');
      return;
    }

    const defFiles = (await fsp.readdir(DEFAULTS_DIR))
      .filter(f => f.toLowerCase().endsWith('.js'));

    if (defFiles.length === 0) {
      console.warn('[algo.defaults] defaults dir is empty:', DEFAULTS_DIR);
      return;
    }

    console.log('[algo.defaults] seeding', defFiles.length, 'file(s) from', DEFAULTS_DIR);

    // Copy each default, prefix with a short id to match your "<id>-<name>.js" scheme
    for (const srcName of defFiles) {
      const srcPath = path.join(DEFAULTS_DIR, srcName);
      const id = shortId();
      const destName = `${id}-${safeName(srcName)}`;
      const destPath = path.join(baseDir, destName);
      await fsp.copyFile(srcPath, destPath);
    }

    // Merge into index (uses your existing folder->index logic)
    await rebuildIndexFromFolder();

    console.log('[algo.defaults] bootstrap complete');
  } catch (e) {
    console.error('[algo.defaults] bootstrap failed:', (e as Error)?.message || e);
  }
}

function resolveDataDir(): string {
  // 1) allow override
  if (process.env.TL_DATA_DIR) return process.env.TL_DATA_DIR;

  // 2) Electron userData (if available)
  try {
    // lazy require so webpack/electron don’t fight
    const electron = (eval('require') as NodeRequire)('electron');
    const app = electron?.app || electron?.remote?.app;
    if (app && typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), 'trading-algos');
    }
  } catch {}

  // 3) per-user fallback
  return path.join(os.homedir(), '.tradelayer', 'trading-algos');
}

const baseDir = resolveDataDir();
const indexPath = path.join(baseDir, 'index.json');
const legacyIdx = path.join(baseDir, 'index');

export type AlgoParamSpec =
  | { type: 'int'    , default: number, min?: number, max?: number, step?: number }
  | { type: 'number' , default: number, min?: number, max?: number, step?: number }
  | { type: 'string' , default?: string, enum?: string[] }
  | { type: 'bool'   , default?: boolean };

export interface AlgoMeta {
  name: string;
  symbol: string;                   // e.g. BTCUSDT
  venue?: string;                   // e.g. binance
  mode: 'SPOT' | 'FUTURES';
  leverage?: number;
  timeframe?: string;               // e.g. 15m, 1h
  description?: string;
  tags?: string[];
  parameters?: Record<string, AlgoParamSpec>;
  risk?: {
    stopLossPct?: number;
    takeProfitPct?: number;
    maxLeverage?: number;
    maxPositions?: number;
  };
  author?: string;
  version?: string;
}

export interface AlgoIndexItem {
  id: string;
  name: string;
  fileName: string;
  fullPath: string;
  size: number;
  createdAt: number;
  status: 'stopped' | 'running';
  amount?: number;
  // NEW:
  meta?: AlgoMeta;
}

const ALGO_BLOCK_RE = /\/\*\s*@algo([\s\S]*?)@algo\s*\*\//i;
const ALGO_LINE_RE  = /^\s*\/\/\s*@algo\s*({[\s\S]*})\s*$/m;

function parseAlgoMetaFromSource(src: string): AlgoMeta | undefined {
  try {
    // Block form
    const m = ALGO_BLOCK_RE.exec(src);
    if (m && m[1]) {
      const json = m[1].trim();
      return normalizeMeta(JSON.parse(json));
    }
    // Single-line fallback
    const m2 = ALGO_LINE_RE.exec(src);
    if (m2 && m2[1]) {
      return normalizeMeta(JSON.parse(m2[1]));
    }
  } catch (e) {
    console.warn('[algo.meta] failed to parse @algo block:', (e as Error)?.message);
  }
  return undefined;
}

function normalizeMeta(m: any): AlgoMeta | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const mode = String(m.mode || '').toUpperCase();
  const norm: AlgoMeta = {
    name: String(m.name || m.symbol || 'Unnamed Strategy'),
    symbol: String(m.symbol || '').toUpperCase(),
    venue: m.venue ? String(m.venue) : undefined,
    mode: mode === 'FUTURES' ? 'FUTURES' : 'SPOT',
    leverage: m.leverage != null ? Number(m.leverage) : undefined,
    timeframe: m.timeframe ? String(m.timeframe) : undefined,
    description: m.description ? String(m.description) : undefined,
    tags: Array.isArray(m.tags) ? m.tags.map((t: any) => String(t)) : undefined,
    parameters: (m.parameters && typeof m.parameters === 'object') ? m.parameters : undefined,
    risk: (m.risk && typeof m.risk === 'object') ? m.risk : undefined,
    author: m.author ? String(m.author) : undefined,
    version: m.version ? String(m.version) : undefined,
  };
  // minimal validity
  if (!norm.symbol) return norm; // still OK; UI can show name only
  return norm;
}


type UploadBody = { name: string; dataBase64: string };
type RunBody = { systemId: string; amount?: number };
type StopBody = { systemId: string };
type AllocateBody = { systemId: string; amount: number };

if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
if (!fs.existsSync(indexPath)) fs.writeFileSync(indexPath, '[]');


// --- small utils
const stripBom = (s: string) => s.replace(/^\uFEFF/, '');
const shortId = () =>(uuidv4().replace(/-/g, '').slice(0, 12));
// ---------- tiny mutex ----------
let _lock = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = _lock.then(fn, fn);
  _lock = run.then(() => undefined, () => undefined);
  return run;
}

// ---------- ensure dir + index.json ----------
async function ensureIndexFile() {
  await fsp.mkdir(baseDir, { recursive: true });
  const hasJson   = await fsp.access(indexPath).then(() => true).catch(() => false);
  const hasLegacy = await fsp.access(legacyIdx).then(() => true).catch(() => false);

  if (!hasJson && hasLegacy) {
    try {
      const raw = await fsp.readFile(legacyIdx, 'utf8');
      const parsed = JSON.parse(stripBom(raw) || '[]');
      await fsp.writeFile(indexPath, JSON.stringify(parsed, null, 2), 'utf8');
      console.log('[algo.index] migrated legacy ->', indexPath, 'items:',
        Array.isArray(parsed) ? parsed.length : 0);
      return;
    } catch (e) {
      console.warn('[algo.index] legacy migration failed, writing empty index:', e);
    }
  }

  if (!hasJson) {
    await fsp.writeFile(indexPath, '[]', 'utf8');
    console.log('[algo.index] created new index at', indexPath);
  }
}

// ---------- normalizer (keeps union literals) ----------
function normalizeIndexArray(val: any): AlgoIndexItem[] {
  if (!Array.isArray(val)) return [];
  return val.map((o: any) => ({
    id: String(o?.id ?? ''),
    name: String(o?.name ?? ''),
    fileName: String(o?.fileName ?? ''),
    fullPath: String(o?.fullPath ?? ''),
    size: Number(o?.size ?? 0),
    createdAt: Number(o?.createdAt ?? Date.now()),
    status: o?.status === 'running' ? ('running' as const) : ('stopped' as const),
    amount: typeof o?.amount === 'number' ? o.amount : undefined,
  })).filter(a => a.id && a.fileName && a.fullPath);
}

// ---------- raw rebuild (NO nested locks) ----------
async function rebuildIndexFromFolder(): Promise<AlgoIndexItem[]> {
  await ensureIndexFile();

  // raw read (no withLock)
  let current: AlgoIndexItem[] = [];
  try {
    const raw  = await fsp.readFile(indexPath, 'utf8').catch(() => '[]');
    const text = stripBom(raw || '[]').trim();
    current = normalizeIndexArray(text ? JSON.parse(text) : []);
  } catch {
    current = [];
  }

  const byFile = new Map(current.map(i => [i.fileName, i]));
  const byId   = new Map(current.map(i => [i.id, i]));

  const files = (await fsp.readdir(baseDir))
    .filter(f => f.toLowerCase().endsWith('.js') && f !== 'index.json');

  let touched = 0;

  for (const fileName of files) {
    const fullPath = path.join(baseDir, fileName);
    const stat = await fsp.stat(fullPath);
    const source = await fsp.readFile(fullPath, 'utf8').catch(() => '');
    const meta = parseAlgoMetaFromSource(source);

    // Try "<id>-<name>.js"
    const m = /^([a-f0-9]{8,32})-(.+)\.js$/i.exec(fileName);
    let id: string;
    let name: string;
    if (m) {
      id = m[1];
      name = `${m[2]}.js`;
    } else {
      // stable short id for legacy names
      const hash = (eval('require') as NodeRequire)('crypto')
        .createHash('md5').update(fileName).digest('hex');
      id = hash.slice(0, 12);
      name = fileName;
    }

    let item = byFile.get(fileName) || byId.get(id);
    if (item) {
      if (item.fileName !== fileName) byFile.delete(item.fileName);
      item.id        = id;
      item.name      = name;
      item.fileName  = fileName;
      item.fullPath  = fullPath;
      item.size      = stat.size;
      item.createdAt = item.createdAt || stat.mtimeMs;
      if (meta) item.meta = meta;
    } else {
      item = {
        id,
        name,
        fileName,
        fullPath,
        size: stat.size,
        createdAt: stat.mtimeMs,
        status: 'stopped' as const,
        amount: 0,
        meta,
      };
      current.push(item);
      byFile.set(fileName, item);
      byId.set(id, item);
    }
    touched++;
  }

  if (touched > 0) {
    const tmp = indexPath + '.tmp';                 // atomic write
    await fsp.writeFile(tmp, JSON.stringify(current, null, 2), 'utf8');
    await fsp.rename(tmp, indexPath);
  }

  console.log('[algo.index] rebuild — files:', files.length,
              'merged:', touched, 'total:', current.length);
  return current;
}

// ---------- readers/writers (single-lock entry points) ----------
export const readIndex = async (): Promise<AlgoIndexItem[]> =>
  withLock(async () => {
    await ensureIndexFile();
    let arr: AlgoIndexItem[] = [];

    try {
      const raw  = await fsp.readFile(indexPath, 'utf8');
      const text = stripBom(raw).trim();
      arr = text ? normalizeIndexArray(JSON.parse(text)) : [];
    } catch (err) {
      // backup bad file then reset to []
      try {
        const bad = await fsp.readFile(indexPath).catch(() => null);
        if (bad) {
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const backup = path.join(baseDir, `index.broken.${ts}.json`);
          await fsp.writeFile(backup, bad);
          console.error('[algo.index] corrupted index backed up to', backup);
        }
      } catch {}
      await fsp.writeFile(indexPath, '[]', 'utf8');
      arr = [];
    }

    // Rebuild if empty OR folder has unindexed .js files
    try {
      const files = (await fsp.readdir(baseDir))
        .filter(f => f.toLowerCase().endsWith('.js') && f !== 'index.json');

      const indexed = new Set(arr.map(i => i.fileName));
      const needsRebuild = arr.length === 0 || files.some(f => !indexed.has(f));

      if (needsRebuild) {
        console.log('[algo.index] readIndex -> rebuilding from folder…');
        const rebuilt = await rebuildIndexFromFolder();   // raw I/O inside; safe under lock
        console.log('[algo.index] rebuild complete, items:', rebuilt.length);
        return rebuilt;
      }
    } catch (e) {
      console.warn('[algo.index] readdir failed; keeping current index:',
        (e as Error)?.message);
    }

    console.log('[algo.index] read', arr.length, 'items from', indexPath);
    return arr;
  });

export const writeIndex = async (list: AlgoIndexItem[]) =>
  withLock(async () => {
    await ensureIndexFile();
    const tmp = indexPath + '.tmp'; // atomic write
    const payload = JSON.stringify(Array.isArray(list) ? list : [], null, 2);
    await fsp.writeFile(tmp, payload, 'utf8');
    await fsp.rename(tmp, indexPath);
    console.log('[algo.index] wrote',
      Array.isArray(list) ? list.length : 0, 'items to', indexPath);
  });


const byId = (list: AlgoIndexItem[], id: string) => list.find(a => a.id === id);

// helper to handle both sync/async disconnect signatures
function disconnectPm2(): Promise<void> {
  return new Promise<void>((resolve) => {
    const d = (pm2().disconnect as any);
    try {
      if (typeof d === 'function' && d.length > 0) {
        // older typings: disconnect(cb)
        d(() => resolve());
      } else {
        // newer typings: disconnect(): void
        pm2().disconnect();
        resolve();
      }
    } catch {
      // ignore disconnect errors
      resolve();
    }
  });
}

export async function withPm2<T>(fn: () => Promise<T>): Promise<T> {
  // connect
  await new Promise<void>((res, rej) =>
    pm2().connect((err: any) => (err ? rej(err) : res()))
  );

  try {
    // do the thing while connected
    return await fn();
  } finally {
    // always disconnect (and wait for it if callback-based)
    await disconnectPm2();
  }
}

const pm2Name = (systemId: string) => `algo:${systemId}`;

/** ------- route handlers (function exports) ------- */

/** POST /api/algo/upload
 * Supports:
 *  - multipart (field name "file") when @fastify/multipart is registered
 *  - JSON { filePath, name? } to copy local file into managed folder
 */
export async function uploadAlgo(request, reply) {
  console.log("Incoming uploadAlgo body:", request.body);

  try {
    const { name, dataBase64 } = request.body as { name?: string; dataBase64?: string };
    if (!dataBase64) {
      return reply.status(400).send({ error: "Missing dataBase64" });
    }

    const buf = Buffer.from(dataBase64, "base64");
    const fileSize = buf.length;
    const id = shortId();
    const base = (name ?? 'algo').replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/\.js$/i, '');
    const fileName = `${id}-${base}.js`;
    const target = path.join(process.cwd(), "trading-algos", fileName);

    // Ensure directory exists
    await fs.promises.mkdir(path.dirname(target), { recursive: true });

    // Write file
    await fs.promises.writeFile(target, buf);

    console.log("Wrote file to:", target);

    const list = await readIndex();
      list.push({
        id,
        name,
        fileName,
        size: fileSize,
        fullPath: target,
        createdAt: Date.now(),
        status: 'stopped' as const,
        amount: 0,
      });
      await writeIndex(list);

    return reply.send({ ok: true, systemId: id });
  } catch (err) {
    console.error("uploadAlgo error:", err);
    return reply.status(500).send({ error: err.message || "Unknown error" });
  }
}

/** POST /api/algo/run { systemId, amount? } */
export async function runAlgo(request: FastifyRequest, reply: FastifyReply) {
  const { systemId, amount }: RunBody = request.body as RunBody;
  if (!systemId) return reply.status(400).send({ error: 'systemId required' });

  const list = await readIndex();
  const item = byId(list, systemId);
  if (!item) return reply.status(404).send({ error: 'system not found' });

  await withPm2(async () => {
    await new Promise<void>((res, rej) => {
      pm2().start(
        { script: item.fullPath, name: pm2Name(systemId), env: { SIZE: String(amount ?? item.amount ?? 0) } },
        err => (err ? rej(err) : res())
      );
    });
    return;
  });

  item.status = 'running';
  if (typeof amount === 'number') item.amount = amount;
  await writeIndex(list);

  return reply.send({ ok: true });
}

/** POST /api/algo/stop { systemId } */
export async function stopAlgo(request: FastifyRequest, reply: FastifyReply) {
  const { systemId }: StopBody = request.body as StopBody;
  if (!systemId) return reply.status(400).send({ error: 'systemId required' });

  const list = await readIndex();
  const item = byId(list, systemId);
  if (!item) return reply.status(404).send({ error: 'system not found' });

  await withPm2(async () => {
    await new Promise<void>((res, rej) => {
      pm2().delete(pm2Name(systemId), err => (err ? rej(err) : res()));
    });
    return;
  });

  item.status = 'stopped';
  await writeIndex(list);

  return reply.send({ ok: true });
}

/** POST /api/algo/allocate { systemId, amount } */
export async function allocateAlgo(request: FastifyRequest, reply: FastifyReply) {
  const { systemId, amount }: AllocateBody = request.body as AllocateBody;
  if (!systemId || typeof amount !== 'number') {
    return reply.status(400).send({ error: 'systemId and numeric amount required' });
  }

  const list = await readIndex();
  const item = byId(list, systemId);
  if (!item) return reply.status(404).send({ error: 'system not found' });

  // build env for the process
  const baseEnv: Record<string, string> = {
    SIZE: String(amount),
  };

  // also include meta fields if available
  if (item.meta?.name)        baseEnv.ALGO_NAME = item.meta.name;
  if (item.meta?.description) baseEnv.ALGO_DESC = item.meta.description;
    baseEnv.TARGET_EXPOSURE = String(amount);

  const envKey = `${item.name.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()}_TARGET_EXPOSURE`;

  await withPm2(async () => {
    await new Promise<void>((res, rej) => {
      pm2().start(
        {
          script: item.fullPath,
          name: pm2Name(systemId),
          env: { [envKey]: String(amount) },  // ✅ namespaced env
        },
        (err: any) => {
          if (err && err.message?.includes('process name already exists')) {
            pm2().restart(
              {
                name: pm2Name(systemId),
                env: { [envKey]: String(amount) },
                /* @ts-ignore */ updateEnv: true,
              } as any,
              (e: any) => (e ? rej(e) : res())
            );
          } else if (err) {
            rej(err);
          } else {
            res();
          }
        }
      );
    });
  });

  item.status = 'running';
  item.amount = amount;
  await writeIndex(list);

  return reply.send({ ok: true });
}

/** GET /api/algo/discovery */
export async function discoveryAlgo(request: FastifyRequest, reply: FastifyReply) {
  console.log('inside discover algo ')
  const list = await readIndex();
  return reply.send(
    list.map(i => ({
      id: i.id,
      name: i.name,
      size: i.size,
      createdAt: i.createdAt,
      status: i.status || 'stopped',
    }))
  );
}

/** GET /api/algo/running */
export async function runningAlgo(request: FastifyRequest, reply: FastifyReply) {
  const list = await readIndex();
  const names = new Set(list.map(i => pm2Name(i.id)));

  const runningNames = await withPm2(async () => {
    const procs = await new Promise<ProcessDescription[]>((res, rej) => {
      pm2().list((err: any, list: ProcessDescription[]) => (err ? rej(err) : res(list)));
    });
    return new Set((procs || []).filter(p => p?.name && names.has(p.name!)).map(p => p.name!));
  });

  const running = list
    .filter(i => runningNames.has(pm2Name(i.id)))
    .map(i => ({ id: i.id, name: i.name, amount: i.amount ?? 0, status: 'running' as const }));

  return reply.send(running);
}
