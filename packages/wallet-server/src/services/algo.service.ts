import { FastifyReply, FastifyRequest } from 'fastify';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { ProcessDescription } from 'pm2';
import { v4 as uuidv4 } from 'uuid';
import * as os from 'os';
import { OBSocketService } from './ob-sockets.service';
import * as crypto from 'crypto';
import type { Dirent } from 'fs';
import { existsSync, writeFileSync } from 'fs';
import { spawn } from 'child_process';

export async function ensureAlgoDeps(algoDir: string): Promise<void> {
  const nm  = path.join(algoDir, 'node_modules');
  const pkg = path.join(algoDir, 'package.json');
  if (existsSync(nm) || !existsSync(pkg)) return; // already installed or no manifest

  // Prevent parallel installs in the same folder (optional)
  const lock = path.join(algoDir, '.install.lock');
  if (existsSync(lock)) return;
  try { writeFileSync(lock, String(Date.now())); } catch {}

  const cmd  = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = [
    'install',
    '--omit=dev',
    '--omit=optional',
    '--legacy-peer-deps', // friendlier on Node 14 trees
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
  ];

  await new Promise<void>((resolve) => {
    const p = spawn(cmd, args, { cwd: algoDir, stdio: 'inherit', env: process.env });

    // NEVER reject; just log and continue
    p.on('exit', (code) => {
      if (code && code !== 0) console.warn(`[ensureAlgoDeps] npm i exit ${code} in ${algoDir} (continuing)`);
      try { writeFileSync(lock, ''); } catch {}
      resolve();
    });
    p.on('error', (err) => {
      console.warn('[ensureAlgoDeps] spawn error (continuing):', err?.message);
      try { writeFileSync(lock, ''); } catch {}
      resolve();
    });
  });
}


let _pm2: any;
function pm2() {
  // use eval('require') so webpack doesn't try to bundle pm2
  if (!_pm2) _pm2 = (eval('require') as NodeRequire)('pm2');
  return _pm2;
}

// lightweight pm2 describe/list shape – avoids needing @types/pm2
type PM2Desc = { name?: string; pm_id?: number; pm2_env?: any };

function* iterMatches(src: string, re: RegExp): Generator<RegExpExecArray, void, unknown> {
  // Ensure global flag so exec() advances
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m: RegExpExecArray | null;
  while ((m = r.exec(src))) yield m;
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

// ---- PATHS / WORKSPACE ----
function getBundledAlgosPath(): string {
  try {
    const electron = (eval('require') as NodeRequire)('electron');
    const app = electron?.app || electron?.remote?.app;
    if (app) {
      const resourcesPath = (process as any).resourcesPath || path.join(process.cwd(), 'resources');
      const direct = path.join(resourcesPath, 'trading-algos');
      const unpacked = path.join(resourcesPath, 'app.asar.unpacked', 'trading-algos');
      if (fs.existsSync(direct)) return direct;
      if (fs.existsSync(unpacked)) return unpacked;
    }
  } catch {}
  // DEV fallback: repo root
  return path.join(process.cwd(), 'trading-algos');
}

function ensureAlgoWorkspace(): string {
  // writable: %APPDATA%/TradeLayer-Wallet/trading-algos
  let userData: string | undefined;
  try {
    const electron = (eval('require') as NodeRequire)('electron');
    const app = electron?.app || electron?.remote?.app;
    userData = app?.getPath('userData');
  } catch {}
  const base = userData || path.join(os.homedir(), '.tradelayer-wallet');
  const dst = path.join(base, 'trading-algos');
  fs.mkdirSync(dst, { recursive: true });

  // Copy bundled files if empty (non-destructive)
  const src = getBundledAlgosPath();
  const existing = fs.existsSync(dst) ? fs.readdirSync(dst).filter(f => f.endsWith('.js')) : [];
  if (existing.length === 0 && fs.existsSync(src)) {
    const stack = [{ s: src, d: dst }];
    while (stack.length) {
      const { s, d } = stack.pop()!;
      for (const ent of fs.readdirSync(s, { withFileTypes: true })) {
        const sp = path.join(s, ent.name);
        const dp = path.join(d, ent.name);
        if (ent.isDirectory()) { if (!fs.existsSync(dp)) fs.mkdirSync(dp); stack.push({ s: sp, d: dp }); }
        else if (!fs.existsSync(dp)) { fs.copyFileSync(sp, dp); }
      }
    }
  }
  return dst;
}

// ---- DEP SCAN / PACKAGE / INSTALL ----
const CORE = new Set(["fs","path","os","url","http","https","net","tls","crypto","stream","events","zlib","util","buffer","child_process","readline","worker_threads"]);

function scanAlgoDeps(dir: string): string[] {
  const pkgs = new Set<string>();
  const exts = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]);
  const skip = new Set(["node_modules", ".git"]);
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (skip.has(ent.name)) continue;
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) { stack.push(p); continue; }
      if (!exts.has(path.extname(ent.name))) continue;
      const src = fs.readFileSync(p, "utf8");
      // imports
      {
        const importRe = /import\s+(?:.+?\s+from\s+)?["']([^"']+)["']/g;
        let m: RegExpExecArray | null;
        while ((m = importRe.exec(src)) !== null) {
          const imp = m[1];
          if (!imp || imp.startsWith('.') || CORE.has(imp)) continue;
          pkgs.add(imp.startsWith('@')
            ? imp.split('/').slice(0, 2).join('/')
            : imp.split('/')[0]
          );
        }
      }

      // requires
      {
        const requireRe = /require\(\s*["']([^"']+)["']\s*\)/g;
        let m: RegExpExecArray | null;
        while ((m = requireRe.exec(src)) !== null) {
          const imp = m[1];
          if (!imp || imp.startsWith('.') || CORE.has(imp)) continue;
          pkgs.add(imp.startsWith('@')
            ? imp.split('/').slice(0, 2).join('/')
            : imp.split('/')[0]
          );
        }
      }

    }
  }
  return Array.from(pkgs).sort();
}

function resolveVersions(pkgs: string[]): Record<string,string> {
  let rootDeps: Record<string,string> = {};
  try {
    const rootPkgPath = path.resolve(process.cwd(), "package.json");
    const root = JSON.parse(fs.readFileSync(rootPkgPath, "utf8"));
    rootDeps = { ...(root.dependencies||{}), ...(root.devDependencies||{}) };
  } catch {}
  const out: Record<string,string> = {};
  for (const p of pkgs) out[p] = rootDeps[p] || "latest";
  return out;
}

async function writeAlgoPackageJson(dir: string, name="tradelayer-algos") {
  const deps = resolveVersions(scanAlgoDeps(dir));
  const pkg = {
    name, version:"0.0.0", private:true,
    type:"module",
    scripts: { start:"node index.js" },
    dependencies: deps
  };
  await fsp.writeFile(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2), "utf8");
}

async function ensureInstalled(dir: string, onLog?: (s:string)=>void) {
  const nm = path.join(dir, "node_modules");
  if (fs.existsSync(nm)) return;
  await new Promise<void>((res, rej) => {
    const cmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const child = (eval('require') as NodeRequire)('child_process')
      .spawn(cmd, ["install"], { cwd: dir, env: process.env });
    const pipe = (b:Buffer)=> onLog?.(b.toString("utf8"));
    child.stdout.on("data", pipe); child.stderr.on("data", pipe);
    child.on("close", (code:number)=> code===0 ? res() : rej(new Error(`npm install exited ${code}`)));
  });
}



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

  try {
    // 2) Packaged app: inside resources
    const electron = (eval('require') as NodeRequire)('electron');
    const app = electron?.app || electron?.remote?.app;
    if (app) {
     const resourcesPath =
  (process as any).resourcesPath || path.join(process.cwd(), 'resources');

      const bundledDir = path.join(resourcesPath, 'trading-algos');
      if (require('fs').existsSync(bundledDir)) {
        return bundledDir;
      }
    }
  } catch {
    // ignore if not running in Electron packaged mode
  }

  // 3) Dev fallback: local root folder
  const localDir = path.join(process.cwd(), 'trading-algos');
  return localDir;
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

// Simple browser + Node safe hash (not cryptographically secure)
function simpleHash(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  }
  return Math.abs(h).toString(16).slice(0, 12);
}

async function rebuildIndexFromFolder(): Promise<AlgoIndexItem[]> {
  await ensureIndexFile();

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
      // fallback to simple hash of fileName
      id = simpleHash(fileName);
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
    const tmp = indexPath + '.tmp';
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

export async function runAlgo(request: FastifyRequest, reply: FastifyReply) {
  const { systemId, amount, network, host, port, test, addr, pub } = request.body as any;
  if (!systemId) return reply.status(400).send({ error: 'systemId required' });

  const list = await readIndex();
  const item = byId(list, systemId);
  if (!item) return reply.status(404).send({ error: 'system not found' });

  const repoRoot = require('path').resolve(process.cwd()); // repo root cwd
  const nodePath = require('path').join(repoRoot, 'node_modules');

  const env: Record<string, string> = {};
  const setIf = (k: string, v: any) => { if (v !== undefined && v !== null && v !== '') env[k] = String(v); };

  // Required for algo to actually connect
    setIf('TL_NETWORK', network);
    setIf('TL_HOST', host);
    setIf('TL_PORT', port);
    setIf('TL_TEST', test ? 'true' : 'false');
    setIf('TL_TLON', 'true');
    setIf('TL_ADDRESS', addr);
    setIf('TL_PUBKEY', pub);

    // --- Keep legacy names too (back-compat) ---
    setIf('NETWORK', network);
    setIf('OB_HOST', host);
    setIf('OB_PORT', port);
    setIf('IS_TESTNET', test ? '1' : '0');
    setIf('USER_ADDR', addr);
    setIf('USER_PUB', pub);

    // sizing
    const size = amount ?? item.amount ?? 0;
    setIf('SIZE', size);
    setIf('QTY', size);

    // module resolution
    setIf('NODE_PATH', nodePath);

  console.log('[runAlgo env]', env, 'script:', item.fullPath);

  await withPm2(async () => {
    await new Promise<void>((res, rej) => {
      pm2().start(
        {
          script: item.fullPath,
          name: pm2Name(systemId),
          env,
          cwd: repoRoot, // resolve requires from repo
          merge_logs: false,
          out_file: outLogPath(item),
          error_file: errLogPath(item),
          log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS',
        },
        (err: any) => (err ? rej(err) : res())
      );
    });
  });

  item.status = 'running';
  if (typeof amount === 'number') item.amount = amount;
  await writeIndex(list);

  return reply.send({ ok: true });
}

  /** POST /api/algo/stop { systemId } */
  export async function stopAlgo(request: FastifyRequest, reply: FastifyReply) {
    const { systemId } = (request.body as StopBody) || {};
    if (!systemId) return reply.status(400).send({ error: 'systemId required' });

    // Accept "id" or "algo:id"
    const raw = String(systemId).trim();
    const id = raw.startsWith('algo:') ? raw.slice('algo:'.length) : raw;
    const canonicalName = pm2Name(id); // "algo:<id>"

    console.log('[stop] raw:', raw, 'id:', id, 'canonical:', canonicalName);

    try {
      // List processes to find the best match
      const procs = await withPm2(
        () =>
          new Promise<PM2Desc[]>((res, rej) =>
            pm2().list((err, list) => (err ? rej(err) : res(list || [])))
          )
      );

      const match =
        procs.find(p => p.name === canonicalName) ||
        procs.find(p => (p.name ?? '').endsWith(id)) ||
        procs.find(p => (p.name ?? '').includes(id)) ||
        procs.find(p => (p.pm2_env as any)?.SYSTEM_ID === id);

      const nameToStop = match?.name ?? canonicalName;
      console.log('[stop] stopping:', nameToStop);

      await withPm2(
        () =>
          new Promise<void>((res, rej) =>
            pm2().stop(nameToStop, err => (err ? rej(err) : res()))
          )
      );
      console.log('[stop] pm2.stop OK');

      // Mark index as stopped
      const list = await readIndex();
      const i = list.findIndex(x => x.id === id);
      if (i >= 0) {
        list[i].status = 'stopped';
        await writeIndex(list);
        console.log('[stop] index updated for', id);
      }

      // Optional: confirm state after stop
      const after = await withPm2(
        () =>
          new Promise<PM2Desc[]>((res, rej) =>
            pm2().describe(nameToStop, (err, d) => (err ? rej(err) : res(d || [])))
          )
      );

      return reply.send({ ok: true, id, pm2: nameToStop, after });
    } catch (e: any) {
      console.warn('[stop] error', e?.message || e);
      return reply.status(500).send({ error: e?.message || 'stop failed', id });
    }
  }

  /** POST /api/algo/allocate { systemId, amount } */
  export async function allocateAlgo(request: FastifyRequest, reply: FastifyReply) {
    const { systemId, amount } = request.body as { systemId?: string; amount?: number };
    if (!systemId || typeof amount !== 'number' || Number.isNaN(amount)) {
      return reply.status(400).send({ error: 'systemId and numeric amount required' });
    }

    const list = await readIndex();
    const item = byId(list, systemId);
    if (!item) return reply.status(404).send({ error: 'system not found' });

    // Base env for the process
    const baseEnv: Record<string, string> = {
      SIZE: String(amount),
      TARGET_EXPOSURE: String(amount),
    };
    if (item.meta?.name)        baseEnv.ALGO_NAME = String(item.meta.name);
    if (item.meta?.description) baseEnv.ALGO_DESC = String(item.meta.description);

    // Namespaced override (e.g., MYALGO_TARGET_EXPOSURE)
    const envKey = `${String(item.name || systemId).replace(/[^a-zA-Z0-9]/g, '').toUpperCase()}_TARGET_EXPOSURE`;
    const mergedEnv = { ...baseEnv, [envKey]: String(amount) };

    const name = pm2Name(systemId);

    // Optional: log files next to the algo (requires outLogPath/errLogPath helpers)
    const pm2CommonOpts: any = {
      script: item.fullPath,
      name,
      env: mergedEnv,
    };
    try {
      // If you added per-algo logging helpers, keep these lines.
      // Otherwise, you can remove them safely.
      pm2CommonOpts.merge_logs = false;
      pm2CommonOpts.out_file = outLogPath(item);
      pm2CommonOpts.error_file = errLogPath(item);
      pm2CommonOpts.log_date_format = 'YYYY-MM-DD HH:mm:ss.SSS';
    } catch {
      // helpers not present; ignore
    }

    await withPm2(async () => {
      // Check if process exists; if so, merge with prior env and restart
      await new Promise<void>((res, rej) => {
        pm2().describe(name, (dErr: any, descList: any[]) => {
          if (dErr) return rej(dErr);

          const exists = Array.isArray(descList) && descList.length > 0;
          if (!exists) {
            // START fresh
            pm2().start(pm2CommonOpts, (err: any) => (err ? rej(err) : res()));
            return;
          }

          // RESTART with merged env (preserve prior)
          const priorEnv = (descList[0]?.pm2_env?.env ?? {}) as Record<string, any>;
          const finalEnv = { ...priorEnv, ...mergedEnv };

          pm2().restart(
            {
              name,
              env: finalEnv,
              // keep logging directives if available
              merge_logs: pm2CommonOpts.merge_logs,
              out_file: pm2CommonOpts.out_file,
              error_file: pm2CommonOpts.error_file,
              log_date_format: pm2CommonOpts.log_date_format,
              /* @ts-ignore */
              updateEnv: true,
            } as any,
            (e: any) => (e ? rej(e) : res())
          );
        });
      });
    });

    // Update index
    item.status = 'running';
    item.amount = amount;
    await writeIndex(list);

    return reply.send({
      ok: true,
      // surface log paths if available
      logs: ((): any => {
        try {
          return { out: outLogPath(item), err: errLogPath(item) };
        } catch {
          return undefined;
        }
      })(),
    });
  }



/**
 * Scan the algos directory and reconcile it against index.json:
 * - add new .js files
 * - remove entries for files that no longer exist
 * - update size/createdAt if changed
 * - keep prior status/amount for existing entries
 */export async function refreshIndex(): Promise<AlgoIndexItem[]> {
  const entries: Dirent[] = await fsp.readdir(baseDir, { withFileTypes: true });
  const jsFiles = entries.filter(e => e.isFile() && e.name.toLowerCase().endsWith('.js'));

  const current = await readIndex();
  const byFile = new Map(current.map(i => [i.fileName, i]));

  const next: AlgoIndexItem[] = [];
  for (const f of jsFiles) {
    const fileName = f.name;
    const fullPath = path.join(baseDir, fileName);
    const st = await fsp.stat(fullPath); // promises API

    const existing = byFile.get(fileName);
    const id = existing?.id ?? crypto.randomBytes(4).toString('hex');
    const status = existing?.status ?? 'stopped';
    const amount = existing?.amount ?? 0;

    next.push({
      id,
      name: fileName.replace(/\.js$/i, ''),
      fileName,
      fullPath,
      size: st.size,
      createdAt: (st as any).birthtimeMs ?? (st as any).ctimeMs ?? Date.now(),
      status,
      amount,
    });

    byFile.delete(fileName);
  }

  // write only if changed (ignore non-identity fields in comparison if you want)
  if (JSON.stringify(current.map(strip)) !== JSON.stringify(next.map(strip))) {
    await writeIndex(next);
  }

  return next;

  function strip(i: AlgoIndexItem) {
    return {
      id: i.id,
      fileName: i.fileName,
      size: i.size,
      createdAt: i.createdAt,
      status: i.status ?? 'stopped',
      amount: i.amount ?? 0,
    };
  }
}


/** GET /api/algo/discovery */
export async function discoveryAlgo(request: FastifyRequest, reply: FastifyReply) {
  ensureAlgoDeps(baseDir)
  const list = await refreshIndex(); 
  console.log('inside discover algo '+JSON.stringify(list))
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

/** GET /api/algo/running */export async function runningAlgo(request: FastifyRequest, reply: FastifyReply) {
  const list  = await readIndex();
  const names = new Set(list.map(i => pm2Name(i.id)));

  const runningNames = await withPm2(async () => {
    const procs = await new Promise<ProcessDescription[]>((res, rej) => {
      pm2().list((err: any, list: ProcessDescription[]) => (err ? rej(err) : res(list)));
    });

    const ONLINE = new Set(['online', 'launching']); // what we consider "running"

    return new Set(
      (procs || [])
        .filter(p => {
          if (!p?.name || !names.has(p.name!)) return false;
          const env: any = p.pm2_env || {};
          const status = env.status || (p as any).status;
          return ONLINE.has(status);
        })
        .map(p => p.name!)
    );
  });

  const running = list
    .filter(i => runningNames.has(pm2Name(i.id)))
    .map(i => ({
      id: i.id,
      name: i.name,
      amount: i.amount ?? 0,
      status: 'running' as const,
    }));

  return reply.send(running);
}


// ====== LOG HELPERS (safe to paste once) ======
function algoBaseDir(item: any): string {
  // If your fullPath is .../trading-algos/<systemId>/index.js,
  // this lands on .../trading-algos/<systemId>
  return path.dirname(item.fullPath);
}

function logsDir(item: any): string {
  const dir = path.join(algoBaseDir(item), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function outLogPath(item: any): string { return path.join(logsDir(item), 'out.log'); }
function errLogPath(item: any): string { return path.join(logsDir(item), 'err.log'); }

function tailFile(file: string, lines = 200): string {
  try {
    if (!fs.existsSync(file)) return '';
    const data = fs.readFileSync(file, 'utf8');
    const arr = data.split(/\r?\n/);
    return arr.slice(Math.max(0, arr.length - lines)).join('\n');
  } catch (e: any) {
    return `[tail error] ${e.message}`;
  }
}

