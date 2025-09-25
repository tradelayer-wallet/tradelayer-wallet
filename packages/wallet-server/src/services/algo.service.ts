import { FastifyReply, FastifyRequest } from 'fastify';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { promises as fs } from 'fs';
import { join, basename } from 'path';
import { pipeline } from 'stream/promises';

const ALGOS_DIR = join(process.cwd(), 'trading-algos');

import type { ProcessDescription } from 'pm2';

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

type UploadBody = { filePath?: string; name?: string; isPublic?: boolean };
type RunBody = { systemId: string; amount?: number };
type StopBody = { systemId: string };
type AllocateBody = { systemId: string; amount: number };

if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
if (!fs.existsSync(indexPath)) fs.writeFileSync(indexPath, '[]');

const readIndex = async (): Promise<AlgoIndexItem[]> => {
  try { return JSON.parse(await fsp.readFile(indexPath, 'utf8')); }
  catch { return []; }
};
const writeIndex = (list: AlgoIndexItem[]) =>
  fsp.writeFile(indexPath, JSON.stringify(list, null, 2), 'utf8');

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
export async function uploadAlgo(request: FastifyRequest, reply: FastifyReply) {
  const isMultipart =
    typeof (request as any).isMultipart === 'function' && (request as any).isMultipart();

  const list = await readIndex();

  if (isMultipart) {
    const filePart = await (request as any).file();
    if (!filePart) return reply.status(400).send({ error: 'Missing file' });

    const origName = filePart.filename || 'algo.js';
    const id = randomUUID();
    const fileName = `${id}-${origName}`;
    const target = path.join(baseDir, fileName);

    await new Promise<void>((res, rej) => {
      const ws = fs.createWriteStream(target);
      filePart.file.pipe(ws);
      ws.on('finish', () => res());
      ws.on('error', rej);
    });

    const stat = await fsp.stat(target);
    const item: AlgoIndexItem = {
      id,
      name: (filePart.fields?.name?.value as string) || origName,
      fileName,
      fullPath: target,
      size: stat.size,
      createdAt: Date.now(),
      status: 'stopped',
    };
    list.push(item);
    await writeIndex(list);

    return reply.send({ ok: true, systemId: id });
  } else {
    const body = request.body as UploadBody;
    if (!body?.filePath) return reply.status(400).send({ error: 'filePath required' });
    if (!fs.existsSync(body.filePath)) return reply.status(404).send({ error: 'filePath not found' });

    const id = randomUUID();
    const origName = path.basename(body.filePath);
    const fileName = `${id}-${origName}`;
    const target = path.join(baseDir, fileName);

    await fsp.copyFile(body.filePath, target);

    const stat = await fsp.stat(target);
    const item: AlgoIndexItem = {
      id,
      name: body.name || origName,
      fileName,
      fullPath: target,
      size: stat.size,
      createdAt: Date.now(),
      status: 'stopped',
    };
    list.push(item);
    await writeIndex(list);

    return reply.send({ ok: true, systemId: id });
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
