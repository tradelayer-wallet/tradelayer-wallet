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
    private pendingMempoolOutputCache: {
        expiresAt: number;
        outputsByAddress: Map<string, IUTXO[]>;
        spentOutpoints: Set<string>;
    } | null = null;
    private readonly pendingMempoolCacheMs = 15000;
    private readonly balanceRefreshIntervalMs = 300000;
    private readonly balanceRefreshBlockCooldownMs = 300000;
    private updateInProgress = false;
    private pendingBalanceRefreshId: ReturnType<typeof setTimeout> | null = null;
    private _balancesVersion = 0;

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

    get balancesVersion() {
        return this._balancesVersion;
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
                console.log('[balance] wallet address set changed', kp);
                if (!kp.length) this.restartBalance();
                this.scheduleBalanceRefresh(true, 0);
            });

        this.rpcService.blockSubs$
            .subscribe(() => this.scheduleBalanceRefresh(false, this.balanceRefreshBlockCooldownMs));

        setInterval(() => this.scheduleBalanceRefresh(false, 0), this.balanceRefreshIntervalMs);
    }

    private scheduleBalanceRefresh(notiffy: boolean, delayMs: number) {
        if (this.pendingBalanceRefreshId) {
            clearTimeout(this.pendingBalanceRefreshId);
            this.pendingBalanceRefreshId = null;
        }

        this.pendingBalanceRefreshId = setTimeout(() => {
            this.pendingBalanceRefreshId = null;
            void this.updateBalances(notiffy);
        }, Math.max(0, Number(delayMs || 0)));
    }

    async updateBalances(notiffy: boolean = true) {
        if (this.updateInProgress) return;
        this.updateInProgress = true;
        console.log('[balance] updateBalances start', { notify: notiffy, addresses: this.authService.walletAddresses?.length || 0 });
        // this.balanceLoading = true;
        try {
            const addressesArray = this.authService.walletAddresses;
            for (let i = 0; i < addressesArray?.length; i++) {
                const address = addressesArray[i];
                console.log('[balance] refreshing address', address);
                await this.updateCoinBalanceForAddressFromUnspents(address);
                await this.updateTokensBalanceForAddress(address);
            }
            this.pruneStaleBalances(addressesArray);
        } catch(err: any) {
            this.toastrService.warning(err.message || `Error with updating balances`, 'Balance Error');
            console.warn('[balance] updateBalances error', err?.message || err);
        } finally {
            this.updateInProgress = false;
            console.log('[balance] updateBalances end');
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
        this._balancesVersion += 1;
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
        this._balancesVersion += 1;
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

    private async getPendingMempoolOutputsByAddress(): Promise<Map<string, IUTXO[]>> {
        const scan = await this.getPendingMempoolState();
        return scan.outputsByAddress;
    }

    private async getPendingMempoolState(): Promise<{
        outputsByAddress: Map<string, IUTXO[]>;
        spentOutpoints: Set<string>;
    }> {
        const now = Date.now();
        if (this.pendingMempoolOutputCache && this.pendingMempoolOutputCache.expiresAt > now) {
            return {
                outputsByAddress: this.pendingMempoolOutputCache.outputsByAddress,
                spentOutpoints: this.pendingMempoolOutputCache.spentOutpoints,
            };
        }

        const mempoolRes = await this.rpcService.rpc('getrawmempool', []);
        if (mempoolRes.error || !Array.isArray(mempoolRes.data) || !mempoolRes.data.length) {
            const empty = new Map<string, IUTXO[]>();
            this.pendingMempoolOutputCache = {
                expiresAt: now + this.pendingMempoolCacheMs,
                outputsByAddress: empty,
                spentOutpoints: new Set<string>(),
            };
            return {
                outputsByAddress: empty,
                spentOutpoints: this.pendingMempoolOutputCache.spentOutpoints,
            };
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
                if (!outputAddress) return;
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

        const outputsByAddress = new Map<string, IUTXO[]>();
        Array.from(pendingOutputs.entries())
            .filter(([outpoint]) => !spentOutpoints.has(outpoint))
            .forEach(([, output]) => {
                if (!output.address) return;
                const existing = outputsByAddress.get(output.address) || [];
                existing.push(output);
                outputsByAddress.set(output.address, existing);
            });

        this.pendingMempoolOutputCache = {
            expiresAt: Date.now() + this.pendingMempoolCacheMs,
            outputsByAddress,
            spentOutpoints,
        };
        return {
            outputsByAddress,
            spentOutpoints,
        };
    }

    private async getPendingMempoolOutputsForAddress(address: string): Promise<IUTXO[]> {
        const outputsByAddress = await this.getPendingMempoolOutputsByAddress();
        return outputsByAddress.get(address) || [];
    }

    private async getCoinBalanceObjForAddress(address: string) {
        if (!address) return { error: 'No address provided for updating the balance' };
        console.log('[balance] fetching utxos for address', address);
        const luRes = await this.rpcService.rpc('listunspent', [0, 999999999, [address]]);
        console.log('returning UTXOs for '+address+' in get coin balances '+JSON.stringify(luRes))
        if (luRes.error || !luRes.data) return { error: luRes.error || 'Undefined Error' };

        const utxos = luRes.data as IUTXO[];
        const pendingState = await this.getPendingMempoolState();
        const liveUtxos = utxos.filter((utxo) => !pendingState.spentOutpoints.has(`${utxo.txid}:${utxo.vout}`));
        const pendingByOutpoint = new Map<string, IUTXO>();
        liveUtxos
            .filter(utxo => utxo.confirmations < minBlocksForBalanceConf)
            .forEach((utxo) => pendingByOutpoint.set(`${utxo.txid}:${utxo.vout}`, utxo));

        try {
            const pendingMempoolOutputs = pendingState.outputsByAddress.get(address) || [];
            pendingMempoolOutputs.forEach((utxo) => {
                pendingByOutpoint.set(`${utxo.txid}:${utxo.vout}`, utxo);
            });
            const spentCount = utxos.length - liveUtxos.length;
            if (spentCount > 0 || pendingMempoolOutputs.length > 0) {
                console.log('[balance] mempool pending applied', {
                    address,
                    spentCount,
                    pendingInCount: pendingMempoolOutputs.length,
                });
            }
        } catch (error) {
            console.warn(`Unable to scan mempool outputs for ${address}`, error);
        }

        const _confirmed = liveUtxos
            .filter(utxo => utxo.confirmations >= minBlocksForBalanceConf)
            .reduce((a, b) => a + b.amount, 0);
        const _unconfirmed = Array.from(pendingByOutpoint.values())
            .reduce((a, b) => a + b.amount, 0);
        const confirmed = parseFloat(_confirmed.toFixed(8));
        const unconfirmed = parseFloat(_unconfirmed.toFixed(8));
        const utxoOutpoints = new Set(liveUtxos.map((utxo) => `${utxo.txid}:${utxo.vout}`));
        const scannedPendingUtxos = Array.from(pendingByOutpoint.values())
            .filter((utxo) => !utxoOutpoints.has(`${utxo.txid}:${utxo.vout}`));

        return { data: { confirmed, unconfirmed, utxos: [...liveUtxos, ...scannedPendingUtxos] } };
    }

    
    private async getTokensBalanceArrForAddress(address: string) {
        if (!address) return { error: 'No address provided for updating the balance' };
        console.log('[balance] fetching token balances for address', address);
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
        this._balancesVersion += 1;
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
        this._balancesVersion += 1;
    }
}
