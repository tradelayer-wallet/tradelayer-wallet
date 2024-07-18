// import { TradelayerInstance, ITLInstanceConfig } from 'tl-js';
import { spawn } from "child_process";
import { join } from 'path';
import * as killPort from 'kill-port';

export class TradeLayerService {
    private port: number = 3000;
    isStarted: boolean = false;
    // tradeLayerInstance: TradelayerInstance;
    constructor() {

    }

    // init(config: ITLInstanceConfig) {
    init() {
        // this.tradeLayerInstance = new TradelayerInstance(config);
        return new Promise((resolve, reject) => {
            const listenerPath = join(__dirname, '..', 'tradelayer', 'walletListener.js');
            const childProcess = spawn(`node`, [listenerPath], {});
            childProcess.stdout.on('data', (data) => {
                resolve(true);
            });
            childProcess.stderr.on('data', (error) => {
                reject(error.toString())
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
        await killPort(this.port);
        // await this.tradeLayerInstance.stop();
    }
}