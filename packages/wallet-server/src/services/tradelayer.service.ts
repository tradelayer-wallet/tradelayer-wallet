// import { TradelayerInstance, ITLInstanceConfig } from 'tl-js';
import axios from 'axios';
import { ChildProcess, spawn } from "child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import killPort from 'kill-port';

export class TradeLayerService {
    private port: number = 3000;
    private childProcess: ChildProcess | null = null;
    private initPromise: Promise<boolean> | null = null;
    isStarted: boolean = false;
    // tradeLayerInstance: TradelayerInstance;
    constructor() {

    }

    private get listenerUrl() {
        return String(process.env.TL_WALLET_LISTENER_URL || `http://127.0.0.1:${this.port}`).replace(/\/+$/, '');
    }

    private get listenerPidFile() {
        return join(tmpdir(), 'tradelayer-wallet-listener.pid');
    }

    private readListenerPid(): number | null {
        try {
            const raw = String(readFileSync(this.listenerPidFile, 'utf8') || '').trim();
            const pid = Number(raw);
            return Number.isFinite(pid) && pid > 0 ? Math.floor(pid) : null;
        } catch {
            return null;
        }
    }

    private writeListenerPid(pid: number) {
        try {
            writeFileSync(this.listenerPidFile, String(pid), 'utf8');
        } catch (_) {}
    }

    private clearListenerPid() {
        try {
            unlinkSync(this.listenerPidFile);
        } catch (_) {}
    }

    private isProcessAlive(pid: number): boolean {
        try {
            process.kill(pid, 0);
            return true;
        } catch {
            return false;
        }
    }

    private async listenerReachable(timeout = 1000) {
        try {
            await axios.post(`${this.listenerUrl}/tl_getSyncStatus`, {}, { timeout });
            return true;
        } catch {
            return false;
        }
    }

    private async reclaimListenerPort() {
        try {
            await killPort(this.port);
        } catch (error) {
            // Best effort: if the port is already free or kill-port cannot resolve it,
            // continue with the normal startup probe.
        }
    }

    private resolveListenerPath() {
        const configuredPath = String(process.env.TL_WALLET_LISTENER_PATH || '').trim();
        const candidates = [
            configuredPath,
            join(__dirname, '..', 'tradelayer', 'src', 'walletListener.js'),
            join(__dirname, '..', '..', 'dist', 'tradelayer', 'src', 'walletListener.js'),
            join(process.cwd(), 'dist', 'tradelayer', 'src', 'walletListener.js'),
        ].filter(Boolean);
        const listenerPath = candidates
            .map((candidate) => resolve(candidate))
            .find((candidate) => existsSync(candidate));

        if (!listenerPath) {
            throw new Error(`TradeLayer listener script not found. Checked: ${candidates.join(', ')}`);
        }

        return listenerPath;
    }

    private getNodeCommandEnv() {
        if (process.env.TL_NODE_BINARY) {
            return {
                command: process.env.TL_NODE_BINARY,
                env: { ...process.env },
            };
        }

        return {
            command: 'node',
            env: { ...process.env },
        };
    }

    private isPortAlreadyInUseError(value: any) {
        const message = String(value?.message || value || '').toLowerCase();
        return message.includes('eaddrinuse')
            || message.includes('address already in use')
            || message.includes(`:${this.port}`);
    }

    // init(config: ITLInstanceConfig) {
    async init() {
        const ownedPid = this.readListenerPid();
        if (ownedPid && this.isProcessAlive(ownedPid) && await this.listenerReachable()) {
            this.isStarted = true;
            console.log(`TradeLayer listener is already reachable and owned by pid ${ownedPid}.`);
            return true;
        }

        if (!ownedPid && await this.listenerReachable()) {
            this.isStarted = true;
            console.log('TradeLayer listener is already reachable.');
            return true;
        }

        if (ownedPid && this.isProcessAlive(ownedPid) && !(await this.listenerReachable())) {
            this.isStarted = true;
            console.log(`TradeLayer listener pid ${ownedPid} is alive; waiting for it to become reachable.`);
            void (async () => {
                const deadline = Date.now() + 15000;
                while (Date.now() < deadline) {
                    if (await this.listenerReachable(1500)) {
                        console.log(`TradeLayer listener pid ${ownedPid} became reachable.`);
                        return;
                    }
                    await new Promise((res) => setTimeout(res, 1000));
                }
                console.log(`TradeLayer listener pid ${ownedPid} is still alive; continuing startup without blocking.`);
            })();
            return true;
        }

        if (this.initPromise) {
            console.log('TradeLayer listener init is already in progress.');
            return this.initPromise;
        }

        if (this.isStarted && this.childProcess && !this.childProcess.killed) {
            console.log('TradeLayer service is already initialized.');
            return Promise.resolve(true); // Return a resolved promise indicating no new initialization
        }

        // this.tradeLayerInstance = new TradelayerInstance(config);
        this.initPromise = this.startListener();
        try {
            return await this.initPromise;
        } finally {
            this.initPromise = null;
        }
    }

    private startListener() {
        return new Promise<boolean>((resolve, reject) => {
            console.log('inside the tl service init');
            const listenerPath = this.resolveListenerPath();
            const { command, env } = this.getNodeCommandEnv();
            const childProcess = spawn(command, [listenerPath], {
                cwd: dirname(dirname(listenerPath)),
                env,
                windowsHide: true,
            });
            this.childProcess = childProcess;
            this.isStarted = true;
            this.writeListenerPid(childProcess.pid);
            let settled = false;
            let attempts = 0;
            const maxAttempts = 20;
            let portReclaimed = false;

            const settle = (error?: string) => {
                if (settled) return;
                settled = true;
                clearInterval(probeInterval);
                if (error) {
                    this.isStarted = false;
                    this.clearListenerPid();
                    reject(new Error(error));
                    return;
                }
                resolve(true);
            };

            const probeInterval = setInterval(async () => {
                attempts++;
                if (await this.listenerReachable(1500)) {
                    settle();
                    return;
                }
                if (!portReclaimed && attempts >= 2) {
                    portReclaimed = true;
                    await this.reclaimListenerPort();
                }
                if (attempts >= maxAttempts) {
                    settle('TradeLayer listener did not become reachable after startup.');
                }
            }, 500);

            childProcess.stdout.on('data', (data) => {
                console.log(data.toString());
            });
            childProcess.stderr.on('data', (error) => {
                const errorText = error.toString();
                console.log('err in child process stream '+errorText);
                if (this.isPortAlreadyInUseError(errorText)) {
                    setTimeout(async () => {
                        if (await this.listenerReachable(1500)) {
                            console.log('TradeLayer listener port is occupied by a reachable listener; attaching.');
                            settle();
                        }
                    }, 250);
                }
            });
            childProcess.once('error', (error) => {
                this.childProcess = null;
                this.isStarted = false;
                this.clearListenerPid();
                if (this.isPortAlreadyInUseError(error)) {
                    console.log('TradeLayer listener port already in use during startup; waiting for the existing listener or reclaiming it.');
                }
                settle(error?.message || 'Failed to start TradeLayer listener.');
            });
            childProcess.once('exit', async (code, signal) => {
                this.childProcess = null;
                this.isStarted = false;
                this.clearListenerPid();
                if (!settled) {
                    if (await this.listenerReachable(1500)) {
                        console.log('TradeLayer listener child exited, but a listener is reachable; attaching.');
                        settle();
                        return;
                    }
                    settle(`TradeLayer listener exited before becoming reachable. code=${code} signal=${signal}`);
                }
            });
        });
    }

    async start() {
        if (this.isStarted) return;
        this.isStarted = true;
        // await this.tradeLayerInstance.start();
    }

    async stop() {
        if (!this.isStarted) return;
        this.isStarted = false;
        const ownsChildProcess = this.childProcess && !this.childProcess.killed;
        if (this.childProcess && !this.childProcess.killed) {
            this.childProcess.kill();
        }
        this.childProcess = null;
        if (ownsChildProcess) {
            await killPort(this.port);
        }
        this.clearListenerPid();
        // await this.tradeLayerInstance.stop();
    }
}
