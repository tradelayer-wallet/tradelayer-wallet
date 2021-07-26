import { Client } from 'litecoin'
import { ListenerServer } from './listener';
import { asyncClient } from './common/async-client';
import { IListenerOptions, IRPCConenction, LITOptions, TClient, Trade, TradeTypes } from './common/types';
import { LtcInstantTrade } from './receiver/ltcInstantTrade';

export class SocketScript {
    private _ltcClient: any;
    private _listener: ListenerServer;
    private _asyncClient: TClient;
    constructor() {}

    get ltcClient() {
        return this._ltcClient;
    }

    private set ltcClient(value: any) {
        this._ltcClient = value;
    }

    private get listener() {
        return this._listener;
    }

    private set listener(value: ListenerServer) {
        this._listener = value;
    }

    get asyncClient() {
        return this._asyncClient;
    }

    set asyncClient(value: TClient) {
        this._asyncClient = value;
    }

    connect(rpcConnection: IRPCConenction): Promise<boolean> {
        return new Promise(async (res, rej) => {
            const { user, pass, host, port, ssl, timeout } = rpcConnection;
            this.ltcClient = new Client({
                user: user,
                pass: pass,
                host: host || 'localhost',
                port: port || 9332,
                ssl: ssl ||  false,
                timeout: timeout || 3000,
            });
            const newAsyncClent: TClient = asyncClient(this.ltcClient);
            const checkRes = await newAsyncClent("tl_getinfo");
            const { data, error } = checkRes;
            if (!error && data?.['block']) {
                console.log(`Socket Script is Connected to the RPC`);
                this.asyncClient = newAsyncClent;
                res(true);
            } else {
                console.log(`There is an Error with RPC connection`);
                this.ltcClient = null;
                res(false);
            }
        });
    }

    startListener(listenerOptions: IListenerOptions): void {
        const { address, logs } = listenerOptions;
        const port = 9876;
        if (!address) return;
        this.listener = new ListenerServer(address, port, this.asyncClient, logs);
    }

    stopListener() {
        if (this.listener) this.listener.close();
    }

    ltcInstantTrade(host: string, trade: LITOptions, options: { logs: boolean, send: boolean }) {
        return new LtcInstantTrade(this.asyncClient, host, trade, options);
    }
}

// const test = () => {
//     const rpcConenctionOptions: IRPCConenction = {
//         user: 'user',
//         pass: 'passwrod',
//     };

//     const socketScript = new SocketScript();

//     socketScript.connect(rpcConenctionOptions).then((isConnected) => {
//         if (!isConnected) return;
//         socketScript.initListener({
//             address: 'ms51vD4rsaR3m7ueN1d1wyFFTHXBEJL8Cr',
//             logs: true,
//         });

//         setTimeout(() => {
//             const host = 'localhost';
//             const trade: LITOptions = {
//                 type: TradeTypes.LTC_INSTANT_TRADE,
//                 propertyid: 10,
//                 amount: 0.002,
//                 price: 0.05,
//                 address: 'mqxFCs1W4T4qdew3GTEnXMe4w7mx7uKyf9',
//                 pubkey: '03ab0b06183230ff8b577d4024ea246fd9cda37d63e23b8cc6d5a69a92280e6dde',
//             }
//             const myTrade = socketScript.ltcInstantTrade(host, trade, { logs: true, send: false });
//             myTrade.onReady().then(e => console.log(e));
//         }, 2000)
//     });
// }
// test();