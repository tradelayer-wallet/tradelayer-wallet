import { FastifyReply, FastifyRequest } from 'fastify';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import type { ProcessDescription } from 'pm2';
import { v4 as uuidv4 } from 'uuid';

let _pm2: any;
function pm2() {
  // use eval('require') so webpack doesn't try to bundle pm2
  if (!_pm2) _pm2 = (eval('require') as NodeRequire)('pm2');
  return _pm2;
}
import { randomUUID } from 'crypto';

/** ------- storage layout & helpers (module scope) ------- */
const baseDir = path.join(process.cwd(), 'trading-algos');
const indexPath = path.join(baseDir, 'index.json');
const legacyIdx = path.join(baseDir, 'index');

type AlgoIndexItem = {
  id: string;
  name: string;
  fileName: string;   // relative inside baseDir
  fullPath: string;   // absolute path on disk
  size: number;
  createdAt: number;
  status?: 'stopped' | 'running';
  amount?: number;    // current sizing param
};

type UploadBody = { name: string; dataBase64: string };
type RunBody = { systemId: string; amount?: number };
type StopBody = { systemId: string };
type AllocateBody = { systemId: string; amount: number };

if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
if (!fs.existsSync(indexPath)) fs.writeFileSync(indexPath, '[]');


// --- small utils
const stripBom = (s: string) => s.replace(/^\uFEFF/, '');
let _lock = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = _lock.then(fn, fn);
  _lock = run.then(() => undefined, () => undefined);
  return run;
}

/** Ensure folder and index.json exist; migrate legacy file if present. */
async function ensureIndexFile(): Promise<void> {
  await fsp.mkdir(baseDir, { recursive: true });

  const [hasJson, hasLegacy] = await Promise.all([
    fsp.access(indexPath).then(() => true).catch(() => false),
    fsp.access(legacyIdx).then(() => true).catch(() => false),
  ]);

  if (!hasJson && hasLegacy) {
    try {
      const raw = await fsp.readFile(legacyIdx, 'utf8');
      const parsed = JSON.parse(stripBom(raw) || '[]');
      await fsp.writeFile(indexPath, JSON.stringify(parsed ?? [], null, 2), 'utf8');
      return;
    } catch {
      // fall through to create empty json
    }
  }

  if (!hasJson) {
    await fsp.writeFile(indexPath, '[]', 'utf8');
  }
}

/** If index is empty/corrupt, rebuild it by scanning the folder. */
async function rebuildIndexFromFolder(): Promise<AlgoIndexItem[]> {
  await ensureIndexFile();

  const files = (await fsp.readdir(baseDir))
    .filter(f => f.toLowerCase().endsWith('.js') && f !== 'index.json');

  const list: AlgoIndexItem[] = [];
  for (const fileName of files) {
    const fullPath = path.join(baseDir, fileName);
    const stat = await fsp.stat(fullPath);

    // Try to recover id from "<id>-<origName>.js"
    const withoutExt = fileName.replace(/\.js$/i, '');
    const dash = withoutExt.indexOf('-');
    const id = dash > 0 ? withoutExt.slice(0, dash) : uuidv4();

    list.push({
      id,
      name: dash > 0 ? withoutExt.slice(dash + 1) + '.js' : fileName,
      fileName,
      fullPath,
      size: stat.size,
      createdAt: stat.mtimeMs,
      status: 'stopped',
    });
  }

  await fsp.writeFile(indexPath, JSON.stringify(list, null, 2), 'utf8');
  return list;
}

/** Robust read: ensures file, tolerates BOM/empty/corruption, auto-rebuilds if needed. */
export const readIndex = async (): Promise<AlgoIndexItem[]> =>
  withLock(async () => {
    await ensureIndexFile();

    try {
      const raw = await fsp.readFile(indexPath, 'utf8');
      const text = stripBom(raw).trim();
      if (!text) {
        // empty file → try to rebuild from folder
        return await rebuildIndexFromFolder();
      }

      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) {
        // wrong shape → rebuild
        return await rebuildIndexFromFolder();
      }

      // happy path
      return parsed as AlgoIndexItem[];
    } catch {
      // read/parse error → backup and rebuild
      try {
        const bad = await fsp.readFile(indexPath).catch(() => null);
        if (bad) {
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          await fsp.writeFile(path.join(baseDir, `index.broken.${ts}.json`), bad);
        }
      } catch {}
      return await rebuildIndexFromFolder();
    }
  });

/** Atomic write with a tiny mutex. */
export const writeIndex = async (list: AlgoIndexItem[]) =>
  withLock(async () => {
    await ensureIndexFile();
    const tmp = indexPath + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(list ?? [], null, 2), 'utf8');
    await fsp.rename(tmp, indexPath);
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
    const id = uuidv4();    
    const fileName = `${id}-${name || "algo.js"}`;
    const target = path.join(process.cwd(), "trading-algos", fileName);

    // Ensure directory exists
    await fs.promises.mkdir(path.dirname(target), { recursive: true });

    // Write file
    await fs.promises.writeFile(target, buf);

    console.log("Wrote file to:", target);

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

  await withPm2(async () => {
  await new Promise<void>((res, rej) => {
      pm2().start(
        { script: item.fullPath, name: pm2Name(systemId), env: { SIZE: String(amount) } },
        (err: any) => {
          if (err && err.message?.includes('process name already exists')) {
            // Use object signature (2 args): (Proc | string | number | ProcessDescription, Callback)
            // updateEnv tells PM2 to merge the provided env into the process' env
            pm2().restart(
              { name: pm2Name(systemId), env: { SIZE: String(amount) }, /* @ts-ignore */ updateEnv: true } as any,
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
export async function discoveryAlgo(_request: FastifyRequest, reply: FastifyReply) {
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
export async function runningAlgo(_request: FastifyRequest, reply: FastifyReply) {
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
