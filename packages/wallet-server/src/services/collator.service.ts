import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';

export interface CollatorStartRequest {
  port?: number;
  wsPath?: string;
  dataDir?: string;
  entryPath?: string;
  clearlistEnforce?: boolean;
  clearlistUrl?: string | null;
  clearlistFailMode?: 'open' | 'closed';
  maxMsgBytes?: number;
  submitRps?: number;
  submitBurst?: number;
}

export interface CollatorStatus {
  running: boolean;
  pid?: number;
  port?: number;
  wsPath?: string;
  wsUrl?: string;
  dataDir?: string;
  entryPath?: string;
  startedAtMs?: number;
  lastExit?: { code: number | null; signal: NodeJS.Signals | null; atMs: number };
  logsTail?: string[];
}

export interface RustSequencerStartRequest {
  exePath?: string;
  args?: string; // raw args string, split on whitespace (MVP)
  port?: number;
  wsPath?: string;
  dataDir?: string;
}

export interface RustSequencerStatus {
  running: boolean;
  pid?: number;
  port?: number;
  wsPath?: string;
  wsUrl?: string;
  dataDir?: string;
  exePath?: string;
  args?: string;
  startedAtMs?: number;
  lastExit?: { code: number | null; signal: NodeJS.Signals | null; atMs: number };
  logsTail?: string[];
}

function guessEntryCandidates(): string[] {
  const out: string[] = [];
  if (process.env.TL_COLLATOR_ENTRY) out.push(process.env.TL_COLLATOR_ENTRY);

  // Packaged Electron apps typically place extra resources under process.resourcesPath.
  const rp = (process as any).resourcesPath;
  if (typeof rp === 'string' && rp) {
    out.push(path.join(rp, 'tl-collator', 'dist', 'index.js'));
    out.push(path.join(rp, 'tl-collator', 'index.js'));
  }

  // Dev layouts: try sibling repo.
  try {
    out.push(path.resolve(process.cwd(), '..', 'tl-collator', 'dist', 'index.js'));
  } catch {}

  // Common absolute path in this workspace.
  out.push('C:\\projects\\tl-collator\\dist\\index.js');
  return Array.from(new Set(out));
}

function guessRustExeCandidates(): string[] {
  const out: string[] = [];
  if (process.env.TL_RUST_SEQ_EXE) out.push(process.env.TL_RUST_SEQ_EXE);

  const rp = (process as any).resourcesPath;
  if (typeof rp === 'string' && rp) {
    out.push(path.join(rp, 'tl-orderbook', 'tl-orderbook.exe'));
    out.push(path.join(rp, 'tl-orderbook', 'orderbook.exe'));
    out.push(path.join(rp, 'tl-orderbook-server', 'dist', 'index.js'));
  }

  // Workspace-friendly guesses (user can override).
  out.push('C:\\Users\\patri\\tl-orderbook-server\\dist\\index.js');
  out.push('C:\\projects\\tl-orderbook\\target\\release\\tl-orderbook.exe');
  out.push('C:\\projects\\tl-orderbook\\target\\release\\orderbook.exe');
  out.push('C:\\projects\\tl-orderbook\\tl-orderbook.exe');
  return Array.from(new Set(out));
}

function firstExisting(paths: string[]): string | null {
  for (const p of paths) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

export class CollatorService {
  private child: ChildProcessWithoutNullStreams | null = null;
  private startedAtMs: number | null = null;
  private lastExit: CollatorStatus['lastExit'] = undefined;
  private logs: string[] = [];
  private logsMax = 2000;

  private cfg: { port: number; wsPath: string; dataDir: string; entryPath: string } | null = null;

  private rustChild: ChildProcessWithoutNullStreams | null = null;
  private rustStartedAtMs: number | null = null;
  private rustLastExit: RustSequencerStatus['lastExit'] = undefined;
  private rustLogs: string[] = [];
  private rustCfg: { port: number; wsPath: string; dataDir: string; exePath: string; args: string } | null = null;

  private pushLog(line: string) {
    const s = String(line || '').trimEnd();
    if (!s) return;
    this.logs.push(s);
    if (this.logs.length > this.logsMax) this.logs.splice(0, this.logs.length - this.logsMax);
  }

  private pushRustLog(line: string) {
    const s = String(line || '').trimEnd();
    if (!s) return;
    this.rustLogs.push(s);
    if (this.rustLogs.length > this.logsMax) this.rustLogs.splice(0, this.rustLogs.length - this.logsMax);
  }

  status(): CollatorStatus {
    const running = !!(this.child && !this.child.killed);
    const port = this.cfg?.port;
    const wsPath = this.cfg?.wsPath;
    const wsUrl = port && wsPath ? `ws://127.0.0.1:${port}${wsPath.startsWith('/') ? wsPath : '/' + wsPath}` : undefined;
    return {
      running,
      pid: this.child?.pid,
      port,
      wsPath,
      wsUrl,
      dataDir: this.cfg?.dataDir,
      entryPath: this.cfg?.entryPath,
      startedAtMs: this.startedAtMs || undefined,
      lastExit: this.lastExit,
      logsTail: this.logs.slice(Math.max(0, this.logs.length - 200)),
    };
  }

  rustStatus(): RustSequencerStatus {
    const running = !!(this.rustChild && !this.rustChild.killed);
    const port = this.rustCfg?.port;
    const wsPath = this.rustCfg?.wsPath;
    const wsUrl = port && wsPath ? `ws://127.0.0.1:${port}${wsPath.startsWith('/') ? wsPath : '/' + wsPath}` : undefined;
    return {
      running,
      pid: this.rustChild?.pid,
      port,
      wsPath,
      wsUrl,
      dataDir: this.rustCfg?.dataDir,
      exePath: this.rustCfg?.exePath,
      args: this.rustCfg?.args,
      startedAtMs: this.rustStartedAtMs || undefined,
      lastExit: this.rustLastExit,
      logsTail: this.rustLogs.slice(Math.max(0, this.rustLogs.length - 200)),
    };
  }

  async start(req: CollatorStartRequest): Promise<CollatorStatus> {
    if (this.child && !this.child.killed) return this.status();

    const port = Number.isFinite(Number(req.port)) ? Number(req.port) : 8787;
    const wsPath = (req.wsPath ? String(req.wsPath) : '/ws').trim() || '/ws';
    const dataDir = (req.dataDir ? String(req.dataDir) : path.resolve(process.cwd(), 'data', 'p2p-collator')).trim();

    const entryPath = req.entryPath
      ? String(req.entryPath)
      : (firstExisting(guessEntryCandidates()) || '');
    if (!entryPath) throw new Error('tl-collator entry not found. Set entryPath or TL_COLLATOR_ENTRY.');
    if (!fs.existsSync(entryPath)) throw new Error(`tl-collator entry does not exist: ${entryPath}`);

    fs.mkdirSync(dataDir, { recursive: true });
    this.logs = [];
    this.lastExit = undefined;

    // IMPORTANT:
    // - In Electron, `process.execPath` is the Electron binary, and native modules like `wrtc`
    //   typically won't match Electron's Node ABI.
    // - Prefer spawning a system `node` (or configured path) so `tl-collator` can use its native deps.
    const nodeExe = (process.env.TL_NODE_EXE || 'node').trim() || 'node';

    const env: any = { ...process.env };
    env.PORT = String(port);
    env.WS_PATH = wsPath;
    env.DATA_DIR = dataDir;
    if (req.maxMsgBytes) env.MAX_MSG_BYTES = String(req.maxMsgBytes);
    if (req.submitRps) env.SUBMIT_RPS = String(req.submitRps);
    if (req.submitBurst) env.SUBMIT_BURST = String(req.submitBurst);
    if (req.clearlistEnforce) env.CLEARLIST_ENFORCE = '1';
    if (req.clearlistUrl) env.CLEARLIST_URL = String(req.clearlistUrl);
    if (req.clearlistFailMode) env.CLEARLIST_FAIL_MODE = req.clearlistFailMode;

    const child = spawn(nodeExe, [entryPath], {
      env,
      stdio: 'pipe',
      windowsHide: true,
    });
    this.child = child;
    this.startedAtMs = Date.now();
    this.cfg = { port, wsPath, dataDir, entryPath };

    child.stdout.on('data', (b) => this.pushLog(b.toString('utf8')));
    child.stderr.on('data', (b) => this.pushLog(b.toString('utf8')));
    child.on('exit', (code, signal) => {
      this.lastExit = { code, signal, atMs: Date.now() };
      this.child = null;
      this.startedAtMs = null;
    });

    // Give it a moment to bind/log; callers can poll status.
    await new Promise((r) => setTimeout(r, 300));
    return this.status();
  }

  async startRust(req: RustSequencerStartRequest): Promise<RustSequencerStatus> {
    if (this.rustChild && !this.rustChild.killed) return this.rustStatus();

    const port = Number.isFinite(Number(req.port)) ? Number(req.port) : 8000;
    // tl-orderbook-server uses a fixed '/ws' path; keep field for UI consistency.
    const wsPath = '/ws';
    const dataDir = (req.dataDir ? String(req.dataDir) : path.resolve(process.cwd(), 'data', 'rust-sequencer')).trim();

    const exePath = req.exePath ? String(req.exePath) : (firstExisting(guessRustExeCandidates()) || '');
    if (!exePath) throw new Error('Rust sequencer exe not found. Set exePath or TL_RUST_SEQ_EXE.');
    if (!fs.existsSync(exePath)) throw new Error(`Rust sequencer exe does not exist: ${exePath}`);

    fs.mkdirSync(dataDir, { recursive: true });
    this.rustLogs = [];
    this.rustLastExit = undefined;

    // Generic arg strategy (MVP): accept raw args string and also pass port/datadir if user didn't.
    const rawArgs = (req.args ? String(req.args) : '').trim();
    const args = rawArgs ? rawArgs.split(/\s+/g).filter(Boolean) : [];

    const env: any = { ...process.env };
    // tl-orderbook-server listens on WS_PORT / WSS_PORT. Also set PORT for other binaries.
    env.WS_PORT = String(port);
    env.PORT = String(port);
    env.DATA_DIR = dataDir;
    env.WS_PATH = wsPath;

    const isJsEntry = exePath.toLowerCase().endsWith('.js') || exePath.toLowerCase().endsWith('.mjs') || exePath.toLowerCase().endsWith('.cjs');
    const nodeExe = (process.env.TL_NODE_EXE || 'node').trim() || 'node';

    // If it's a JS entrypoint (e.g. tl-orderbook-server/dist/index.js), spawn system node to preserve native addon ABI.
    // Otherwise spawn the executable directly.
    const spawnExe = isJsEntry ? nodeExe : exePath;
    const spawnArgs = isJsEntry ? [exePath, ...args] : args;

    // Prefer repo root as cwd when running dist/index.js so native module resolution and env files behave as expected.
    let cwd = process.cwd();
    try {
      const p = path.normalize(exePath);
      if (p.toLowerCase().includes(`${path.sep}dist${path.sep}`)) cwd = path.dirname(path.dirname(p));
      else cwd = path.dirname(p);
    } catch {}

    const child = spawn(spawnExe, spawnArgs, {
      env,
      cwd,
      stdio: 'pipe',
      windowsHide: true,
    });
    this.rustChild = child;
    this.rustStartedAtMs = Date.now();
    this.rustCfg = { port, wsPath, dataDir, exePath, args: rawArgs };

    child.stdout.on('data', (b) => this.pushRustLog(b.toString('utf8')));
    child.stderr.on('data', (b) => this.pushRustLog(b.toString('utf8')));
    child.on('exit', (code, signal) => {
      this.rustLastExit = { code, signal, atMs: Date.now() };
      this.rustChild = null;
      this.rustStartedAtMs = null;
    });

    await new Promise((r) => setTimeout(r, 300));
    return this.rustStatus();
  }

  async stop(): Promise<CollatorStatus> {
    const c = this.child;
    if (!c) return this.status();

    try {
      c.kill('SIGTERM');
    } catch {}

    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (!this.child) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    if (this.child) {
      try {
        this.child.kill('SIGKILL');
      } catch {}
    }

    return this.status();
  }

  async stopRust(): Promise<RustSequencerStatus> {
    const c = this.rustChild;
    if (!c) return this.rustStatus();

    try {
      c.kill('SIGTERM');
    } catch {}

    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (!this.rustChild) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    if (this.rustChild) {
      try {
        this.rustChild.kill('SIGKILL');
      } catch {}
    }

    return this.rustStatus();
  }
}
