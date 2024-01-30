import { Injectable } from "@angular/core";
import { RpcService } from "./rpc.service";
import { ToastrService } from "ngx-toastr";
import { AuthService } from "./auth.service";
import { IUTXO } from "./txs.service";
import { ApiService } from "./api.service";

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
                balance: number;
            }[];
        }
    } = {};

    // public balanceLoading: boolean = false;

    constructor(
        private rpcService: RpcService,
        private authService: AuthService,
        private toastrService: ToastrService,
        private apiService: ApiService,
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

    private async updateTokensBalanceForAddress(address: string) {
        const tokensBalanceArrRes = await this.getTokensBalanceArrForAddress(address);
        if (tokensBalanceArrRes.error || !tokensBalanceArrRes.data) throw new Error(tokensBalanceArrRes.error || `Error with updating balances`);
        if (!this._allBalancesObj[address]) this._allBalancesObj[address] = emptyBalanceObj;
        this._allBalancesObj[address].tokensBalance = tokensBalanceArrRes.data;
    }

    private async getCoinBalanceObjForAddress(address: string) {
        if (!address) return { error: 'No address provided for updating the balance' };
        const luRes = await this.rpcService.rpc('listunspent', [0, 999999999, [address]]);
        if (luRes.error || !luRes.data) return { error: luRes.error || 'Undefined Error' };

        const _confirmed = (luRes.data as IUTXO[])
            .filter(utxo => utxo.confirmations >= minBlocksForBalanceConf)
            .reduce((a, b) => a + b.amount, 0);
        const _unconfirmed = (luRes.data as IUTXO[])
            .filter(utxo => utxo.confirmations < minBlocksForBalanceConf)
            .reduce((a, b) => a + b.amount, 0);
        const confirmed = parseFloat(_confirmed.toFixed(6));
        const unconfirmed = parseFloat(_unconfirmed.toFixed(6));
        return {data: { confirmed, unconfirmed, utxos: luRes.data } };
    }
    private async getTokensBalanceArrForAddress_old(address: string) {
        if (!address) return { error: 'No address provided for updating the balance' };
        const balanceRes = await this.tlApi.rpc('tl_getallbalancesforaddress', [address]).toPromise()
        if (!balanceRes.data || balanceRes.error) return { data: [] };
        try {
            const promisesArray = (balanceRes.data as { propertyid: number, balance: string, reserved: string }[])
                .map(async (token) => ({ ...token, name: await this.getTokenNameById(token.propertyid)}));
            const arr = await Promise.all(promisesArray);
            const data = arr.map((t) => {
                const balObj = {
                    ...t, 
                    balance: parseFloat(t.balance),
                };
                return balObj;
            });
            return { data };
        } catch (error: any) {
            return { error: `Error with getting tokens Balance` };
        }
    }

    private async getTokensBalanceArrForAddress(address: string) {
        if (!address) return { error: 'No address provided for updating the balance' };
        const balanceRes = await this.tlApi.rpc('tl_getallbalancesforaddress', address).toPromise();
        if (!balanceRes.data || balanceRes.error) return { data: [] };
        const data = (balanceRes.data as { propertyId: string, amount: number, available: number, reserved: string }[])
            .map((token) => ({ ...token, name: `token_${token.propertyId}`, propertyid: parseInt(token.propertyId), balance: token.available}));
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
}
