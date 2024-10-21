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

        if (this.isStarted) {
            console.log('TradeLayer service is already initialized.');
            return Promise.resolve(false); // Return a resolved promise indicating no new initialization
        }

        // this.tradeLayerInstance = new TradelayerInstance(config);
        return new Promise((resolve, reject) => {
            console.log('inside the tl service init')
            const listenerPath = join(__dirname, '..', 'tradelayer/src', 'walletListener.js');
            const childProcess = spawn(`node`, [listenerPath], {});
            this.isStarted=true
            childProcess.stdout.on('data', (data) => {
                console.log(data.toString());
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