import { TradelayerInstance, ITLInstanceConfig } from 'tl-js';

export class TradeLayerService {
    isStarted: boolean = false;
    tradeLayerInstance: TradelayerInstance;
    constructor() {

    }

    init(config: ITLInstanceConfig) {
        this.tradeLayerInstance = new TradelayerInstance(config);
    }

    async start() {
        if (this.isStarted) return;
        this.isStarted = true;
        await this.tradeLayerInstance.start();
    }

    async stop() {
        if (!this.isStarted) return;
        this.isStarted = false;
        await this.tradeLayerInstance.stop();
    }
}