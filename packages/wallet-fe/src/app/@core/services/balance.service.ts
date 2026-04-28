import { Injectable } from "@angular/core";
import { RpcService } from "./rpc.service";
import { ToastrService } from "ngx-toastr";
import { AuthService } from "./auth.service";
import { IUTXO, TxsService } from "./txs.service";
import { ApiService } from "./api.service";
import axios from 'axios';  // Add axios import

const minBlocksForBalanceConf: number = 1;
const emptyBalanceObj = {
    coinBalance: {
        confirmed: 0,
        unconfirmed: 0,
        utxos: [],
    },
    tokensBalance: [],
};

@Injectable({
    providedIn: 'root',
})

export class BalanceService {
    private _allBalancesObj: {
        [key: string]: {
            coinBalance: {
                confirmed: number;
                unconfirmed: number;
                utxos: IUTXO[];
            };
            tokensBalance: {
                name: string;
                propertyid: number;
                rawPropertyId?: string;
                amount: number,
                available: number,
                reserved: number,
                margin: number,
                vesting: number,
                channel: number
            }[];
        }
    } = {};

    // public balanceLoading: boolean = false;

    constructor(
        private rpcService: RpcService,
        private authService: AuthService,
        private toastrService: ToastrService,
        private apiService: ApiService,
        private txsService: TxsService   // Inject TxsService here
    ) { }

    get tlApi() {
        return this.apiService.newTlApi;
    }

    get sumAvailableCoins() {
        return Object.values(this._allBalancesObj)
            .reduce((a, b) => a + b.coinBalance.confirmed, 0);
    }

    get allBalances() {
        return this._allBalancesObj;
    }

    getCoinBalancesByAddress(_address: string) {
        const address = _address;
        if (!address) return emptyBalanceObj.coinBalance;
        return this._allBalancesObj?.[address]?.coinBalance || emptyBalanceObj.coinBalance;
    }

    getTokensBalancesByAddress(_address: string) {
        const address = _address;
        if (!address) return [];
        return this._allBalancesObj?.[address]?.tokensBalance || [];
    }

    onInit() {
        //this.tlApi.rpc('tl_loadwallet')
        //this.tlApi.rpc('tl_getAllBalancesForAddress')
        this.authService.updateAddressesSubs$
            .subscribe(kp => {
                if (!kp.length) this.restartBalance();
                this.updateBalances();
            });

        this.rpcService.blockSubs$
            .subscribe(() => this.updateBalances(false));

        setInterval(() => this.updateBalances(false), 20000);
    }

    async updateBalances(notiffy: boolean = true) {
        // this.balanceLoading = true;
        try {
            const addressesArray = this.authService.walletAddresses;
            for (let i = 0; i < addressesArray?.length; i++) {
                const address = addressesArray[i];
                await this.updateCoinBalanceForAddressFromUnspents(address);
                await this.updateTokensBalanceForAddress(address);
            }
            this.pruneStaleBalances(addressesArray);
        } catch(err: any) {
            this.toastrService.warning(err.message || `Error with updating balances`, 'Balance Error');
        }
        // this.balanceLoading = false;
    }

    private async updateCoinBalanceForAddressFromUnspents(address: string) {
        const coinBalanceObjRes = await this.getCoinBalanceObjForAddress(address);
        if (coinBalanceObjRes.error || !coinBalanceObjRes.data) throw new Error(coinBalanceObjRes.error || `Error with updating balances: ${address}`);
        const { confirmed, unconfirmed, utxos } = coinBalanceObjRes.data;
        const coinObj = { confirmed, unconfirmed, utxos };
        if (!this._allBalancesObj[address]) this._allBalancesObj[address] = emptyBalanceObj;
        this._allBalancesObj = {
            ...this._allBalancesObj, 
            [address]: {
                ...this._allBalancesObj[address], 
                coinBalance: coinObj,
            },
        };
    }

    private async consolidateWallet(address: string, network: string) {
            const dustThreshold = 0.000072;
            const coinBalanceObjRes = await this.getCoinBalanceObjForAddress(address);
            
            if (coinBalanceObjRes.error || !coinBalanceObjRes.data) {
                throw new Error(coinBalanceObjRes.error || `Error with updating balances: ${address}`);
            }

            const { confirmed, unconfirmed, utxos } = coinBalanceObjRes.data;
            
            // Define the type for `utxo`
            const smallUtxos = utxos.filter((utxo: IUTXO) => utxo.amount <= dustThreshold);

            if (smallUtxos.length < 2) return;  // No need to consolidate

            // Define the type for `acc` and `utxo`
            const totalAmount = smallUtxos.reduce((acc: number, utxo: IUTXO) => acc + utxo.amount, 0);

            // Create a single transaction sending the totalAmount back to the same address
            const tx = await this.txsService.buildTx({
                fromKeyPair: { address },
                toKeyPair: { address },
                amount: totalAmount,
                inputs: smallUtxos
            });

            if (tx.error) {
                throw new Error(tx.error);
            }

            // Check if tx.data and tx.data.rawtx are defined
            if (tx.data && tx.data.rawtx) {
                console.log('Consolidation TX:', tx.data.rawtx);
            } else {
                throw new Error('Transaction data or rawtx is undefined');
            }
        }

    private async updateTokensBalanceForAddress(address: string) {
        const tokensBalanceArrRes = await this.getTokensBalanceArrForAddress(address);
        if (tokensBalanceArrRes.error || !tokensBalanceArrRes.data) throw new Error(tokensBalanceArrRes.error || `Error with updating balances`);
        if (!this._allBalancesObj[address]) this._allBalancesObj[address] = emptyBalanceObj;
        this._allBalancesObj[address].tokensBalance = tokensBalanceArrRes.data;
    }

    private extractVoutAddress(vout: any): string {
        const scriptPubKey = vout?.scriptPubKey || {};
        const direct = String(scriptPubKey?.address || '').trim();
        if (direct) return direct;
        if (Array.isArray(scriptPubKey?.addresses) && scriptPubKey.addresses.length) {
            return String(scriptPubKey.addresses[0] || '').trim();
        }
        return '';
    }

    private async getPendingMempoolOutputsForAddress(address: string): Promise<IUTXO[]> {
        const mempoolRes = await this.rpcService.rpc('getrawmempool', []);
        if (mempoolRes.error || !Array.isArray(mempoolRes.data) || !mempoolRes.data.length) {
            return [];
        }

        const pendingOutputs = new Map<string, IUTXO>();
        const spentOutpoints = new Set<string>();

        for (const txid of mempoolRes.data as string[]) {
            const txRes = await this.rpcService.rpc('getrawtransaction', [txid, true]);
            const tx = txRes?.data;
            if (txRes.error || !tx) continue;

            (tx.vin || []).forEach((vin: any) => {
                if (vin?.txid != null && vin?.vout != null) {
                    spentOutpoints.add(`${vin.txid}:${vin.vout}`);
                }
            });

            (tx.vout || []).forEach((vout: any) => {
                const outputAddress = this.extractVoutAddress(vout);
                if (outputAddress !== address) return;
                const amount = Number(vout?.value || 0);
                if (!Number.isFinite(amount) || amount <= 0) return;
                const n = Number(vout?.n);
                if (!Number.isInteger(n)) return;
                pendingOutputs.set(`${txid}:${n}`, {
                    txid,
                    vout: n,
                    amount,
                    confirmations: 0,
                    address: outputAddress,
                    scriptPubKey: String(vout?.scriptPubKey?.hex || ''),
                });
            });
        }

        return Array.from(pendingOutputs.entries())
            .filter(([outpoint]) => !spentOutpoints.has(outpoint))
            .map(([, output]) => output);
    }

    private async getCoinBalanceObjForAddress(address: string) {
        if (!address) return { error: 'No address provided for updating the balance' };
        const luRes = await this.rpcService.rpc('listunspent', [0, 999999999, [address]]);
        console.log('returning UTXOs for '+address+' in get coin balances '+JSON.stringify(luRes))
        if (luRes.error || !luRes.data) return { error: luRes.error || 'Undefined Error' };

        const utxos = luRes.data as IUTXO[];
        const pendingByOutpoint = new Map<string, IUTXO>();
        utxos
            .filter(utxo => utxo.confirmations < minBlocksForBalanceConf)
            .forEach((utxo) => pendingByOutpoint.set(`${utxo.txid}:${utxo.vout}`, utxo));

        try {
            const pendingMempoolOutputs = await this.getPendingMempoolOutputsForAddress(address);
            pendingMempoolOutputs.forEach((utxo) => {
                pendingByOutpoint.set(`${utxo.txid}:${utxo.vout}`, utxo);
            });
        } catch (error) {
            console.warn(`Unable to scan mempool outputs for ${address}`, error);
        }

        const _confirmed = utxos
            .filter(utxo => utxo.confirmations >= minBlocksForBalanceConf)
            .reduce((a, b) => a + b.amount, 0);
        const _unconfirmed = Array.from(pendingByOutpoint.values())
            .reduce((a, b) => a + b.amount, 0);
        const confirmed = parseFloat(_confirmed.toFixed(8));
        const unconfirmed = parseFloat(_unconfirmed.toFixed(8));
        const utxoOutpoints = new Set(utxos.map((utxo) => `${utxo.txid}:${utxo.vout}`));
        const scannedPendingUtxos = Array.from(pendingByOutpoint.values())
            .filter((utxo) => !utxoOutpoints.has(`${utxo.txid}:${utxo.vout}`));

        return { data: { confirmed, unconfirmed, utxos: [...utxos, ...scannedPendingUtxos] } };
    }

    
    private async getTokensBalanceArrForAddress(address: string) {
        if (!address) return { error: 'No address provided for updating the balance' };
        const balanceRes = await this.tlApi.rpc('getAllBalancesForAddress', [address]).toPromise();
        console.log('1st load of balance '+address+JSON.stringify(balanceRes))
        if (!balanceRes.data || balanceRes.error) return { data: [] };
        const data = (balanceRes.data as { ticker: string, propertyId: string, amount: number, available: number, reserved: number, margin: number, vesting: number, channel: number }[])
            .map((token) => {
                const rawPropertyId = token?.propertyId != null ? String(token.propertyId) : '';
                const parsedPropertyId = Number.parseInt(rawPropertyId || '0', 10);
                const propertyid = Number.isFinite(parsedPropertyId) && /^\d+$/.test(rawPropertyId)
                    ? parsedPropertyId
                    : 0;
                return {
                ...token, 
                name: token.ticker || '-',  // default to '-' if ticker is undefined
                propertyid,
                rawPropertyId,
                amount: token?.amount || 0,  // safely access amount and default to 0 if undefined
                available: token?.available || 0,  // safely access available and default to 0 if undefined
                reserved: token?.reserved || 0,  // safely access reserved and default to 0 if undefined
                margin: token?.margin || 0,  // safely access margin and default to 0 if undefined
                vesting: token?.vesting || 0,  // safely access vesting and default to 0 if undefined
                channel: token?.channel || 0  // safely access channel and default to 0 if undefined
            };
        });
        console.log('final balance data'+JSON.stringify(data))
        return { data };
    }


    async getTokenNameById(id: number) {
        const existingTokenName = Object.values(this._allBalancesObj)
            .reduce((acc: { name: string, propertyid: number }[], val) => acc.concat(val.tokensBalance), [])
            .find(e => e.propertyid === id);
        if (existingTokenName?.name) return existingTokenName.name;
        const gpRes = await this.tlApi.rpc('tl_getproperty', [id]).toPromise()
        if (gpRes.error || !gpRes.data?.name) return `ID_${id}`;
        return gpRes.data.name;
    }

    private restartBalance() {
        this._allBalancesObj = {};
    }

    private pruneStaleBalances(activeAddresses: string[]) {
        const active = new Set((activeAddresses || []).filter(Boolean));
        const nextBalances: any = {};
        Object.keys(this._allBalancesObj).forEach((address) => {
            if (active.has(address)) {
                nextBalances[address] = this._allBalancesObj[address];
            }
        });
        this._allBalancesObj = nextBalances;
    }
}
