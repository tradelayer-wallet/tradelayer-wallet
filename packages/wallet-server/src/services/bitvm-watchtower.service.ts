import { spawn } from "child_process";
import { join } from "path";

type WatchtowerMode = "alert" | "challenge";

export interface IWatchtowerConfig {
  intervalSec: number;
  mode: WatchtowerMode;
  windowBlocks: number;
  applyImmediate: boolean;
  protocolRepo: string;
  oracleAdminAddress?: string;
  challengerAddress?: string;
  oracleId?: number;
  challengeBondAmount?: number;
  challengeBondPropertyId?: number;
}

interface ILogLine {
  ts: string;
  level: "info" | "error";
  line: string;
}

export class BitvmWatchtowerService {
  private timer: NodeJS.Timeout | null = null;
  private activeChild: any = null;
  private lastRunAt: string | null = null;
  private lastExitCode: number | null = null;
  private lastError: string | null = null;
  private logs: ILogLine[] = [];
  private readonly maxLogs = 400;
  private config: IWatchtowerConfig = this.defaultConfig();

  private defaultConfig(): IWatchtowerConfig {
    return {
      intervalSec: 30,
      mode: "alert",
      windowBlocks: 2,
      applyImmediate: true,
      protocolRepo: process.env.TL_PROTOCOL_REPO || "C:\\projects\\tradelayer.js",
      oracleAdminAddress: process.env.TL_ORACLE_ADMIN_ADDRESS || process.env.TL_ADMIN_ADDRESS || "",
      challengerAddress: process.env.TL_CHALLENGER_ADDRESS || "",
      oracleId: Number(process.env.TL_ORACLE_ID || 1),
      challengeBondAmount: Number(process.env.TL_CHALLENGE_BOND_AMOUNT || 0),
      challengeBondPropertyId: Number(process.env.TL_CHALLENGE_BOND_PROPERTY_ID || 1),
    };
  }

  private pushLog(level: "info" | "error", line: string) {
    const cleaned = String(line || "").trim();
    if (!cleaned) return;
    this.logs.push({ ts: new Date().toISOString(), level, line: cleaned });
    if (this.logs.length > this.maxLogs) {
      this.logs.splice(0, this.logs.length - this.maxLogs);
    }
  }

  private resolveRunnerPath() {
    return join(this.config.protocolRepo, "tests", "bitvmWatchtowerLive.js");
  }

  private buildEnv() {
    const env = { ...process.env };
    env.TL_WATCH_MODE = this.config.mode;
    env.TL_WATCH_WINDOW_BLOCKS = String(this.config.windowBlocks);
    env.TL_APPLY_IMMEDIATE = this.config.applyImmediate ? "true" : "false";
    if (this.config.oracleAdminAddress) env.TL_ORACLE_ADMIN_ADDRESS = this.config.oracleAdminAddress;
    if (this.config.challengerAddress) env.TL_CHALLENGER_ADDRESS = this.config.challengerAddress;
    if (Number.isFinite(Number(this.config.oracleId))) env.TL_ORACLE_ID = String(this.config.oracleId);
    if (Number.isFinite(Number(this.config.challengeBondAmount))) env.TL_CHALLENGE_BOND_AMOUNT = String(this.config.challengeBondAmount);
    if (Number.isFinite(Number(this.config.challengeBondPropertyId))) env.TL_CHALLENGE_BOND_PROPERTY_ID = String(this.config.challengeBondPropertyId);
    return env;
  }

  private async runOnceInternal() {
    if (this.activeChild) {
      this.pushLog("info", "[watchtower-manager] skipped run; previous run still active");
      return;
    }

    const runnerPath = this.resolveRunnerPath();
    this.lastRunAt = new Date().toISOString();
    this.pushLog("info", `[watchtower-manager] run started (${this.config.mode})`);

    await new Promise<void>((resolve) => {
      const child = spawn("node", [runnerPath], {
        cwd: this.config.protocolRepo,
        env: this.buildEnv(),
      });
      this.activeChild = child;

      child.stdout.on("data", (buf: Buffer) => {
        String(buf || "")
          .split(/\r?\n/)
          .forEach((line) => this.pushLog("info", line));
      });

      child.stderr.on("data", (buf: Buffer) => {
        String(buf || "")
          .split(/\r?\n/)
          .forEach((line) => this.pushLog("error", line));
      });

      child.on("error", (err: any) => {
        const msg = String(err?.message || err || "watchtower spawn error");
        this.lastError = msg;
        this.pushLog("error", `[watchtower-manager] ${msg}`);
      });

      child.on("exit", (code: number | null) => {
        this.lastExitCode = Number(code ?? -1);
        if (this.lastExitCode !== 0) {
          this.lastError = `watchtower exited with code ${this.lastExitCode}`;
          this.pushLog("error", `[watchtower-manager] ${this.lastError}`);
        } else {
          this.lastError = null;
          this.pushLog("info", "[watchtower-manager] run completed");
        }
        this.activeChild = null;
        resolve();
      });
    });
  }

  private normalizeConfig(raw: Partial<IWatchtowerConfig>): IWatchtowerConfig {
    const next: IWatchtowerConfig = {
      ...this.config,
      ...raw,
    };
    next.intervalSec = Math.max(5, Number(next.intervalSec || 30));
    next.windowBlocks = Math.max(0, Number(next.windowBlocks || 2));
    next.mode = String(next.mode || "alert").toLowerCase() === "challenge" ? "challenge" : "alert";
    next.applyImmediate = String(next.applyImmediate) !== "false";
    next.protocolRepo = String(next.protocolRepo || this.defaultConfig().protocolRepo);
    return next;
  }

  async start(rawConfig: Partial<IWatchtowerConfig> = {}) {
    this.config = this.normalizeConfig(rawConfig);
    if (this.timer) return this.status();

    await this.runOnceInternal();
    this.timer = setInterval(() => {
      this.runOnceInternal().catch((e: any) => {
        this.lastError = String(e?.message || e || "watchtower run failure");
        this.pushLog("error", `[watchtower-manager] ${this.lastError}`);
      });
    }, this.config.intervalSec * 1000);

    return this.status();
  }

  async run(rawConfig: Partial<IWatchtowerConfig> = {}) {
    this.config = this.normalizeConfig(rawConfig);
    await this.runOnceInternal();
    return this.status();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.activeChild) {
      try {
        this.activeChild.kill();
      } catch (e: any) {
        this.pushLog("error", `[watchtower-manager] kill failed: ${String(e?.message || e || "")}`);
      }
      this.activeChild = null;
    }
    this.pushLog("info", "[watchtower-manager] stopped");
    return this.status();
  }

  status() {
    return {
      running: Boolean(this.timer),
      childActive: Boolean(this.activeChild),
      config: this.config,
      lastRunAt: this.lastRunAt,
      lastExitCode: this.lastExitCode,
      lastError: this.lastError,
      logCount: this.logs.length,
    };
  }

  getLogs(limit = 150) {
    const n = Math.max(1, Math.min(500, Number(limit || 150)));
    return this.logs.slice(-n);
  }
}

