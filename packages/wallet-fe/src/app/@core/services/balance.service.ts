import { Injectable } from "@angular/core";
import { RpcService } from "./rpc.service";
import { SocketService } from "./socket.service";
import { ToastrService } from "ngx-toastr";
import { AuthService } from "./auth.service";

const minBlocksForBalanceConf: number = 1;
const emptyBalanceObj = {
    coinBalance: {
        confirmed: 0,
        unconfirmed: 0,
    },
    tokensBalance: [],
};

export interface IUTXO {
    amount: number;
    confirmations: number;
    scriptPubKey: string;
    txid: string;
    vout: number;
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
            };
            tokensBalance: {
                name: string;
                propertyid: number;
                balance: number;
            }[];
        }
    } = {};

    constructor(
        private rpcService: RpcService,
        private socketService: SocketService,
        private authService: AuthService,
        private toastrService: ToastrService,
    ) {
        this.handleEvents();
    }

    get sumAvailableCoins() {
        return Object.values(this._allBalancesObj)
            .reduce((a, b) => a + b.coinBalance.confirmed, 0);
    }

    get allBalances() {
        return this._allBalancesObj;
    }

    getTokensBalancesByAddress(_address: string) {
        const address = _address;
        if (!address) return [];
        
        return this._allBalancesObj?.[address]?.tokensBalance || [];
    }

    getCoinBalancesByAddress(_address: string) {
        const address = _address;
        if (!address) return emptyBalanceObj.coinBalance;
        return this._allBalancesObj?.[address]?.coinBalance || emptyBalanceObj.coinBalance;
    }

    private handleEvents() {
        this.authService.updateBalanceSubs$
            .subscribe(() => this.updateBalances());

        this.authService.logoutSubs$
            .subscribe(() => this.restartBalance());
        // this.socketService.socket.on('newBlock', (blockHeight) => {
        //     // if (this.rpcService.isApiRPC) return;
        //     this.updateBalances();
        // });
        
        // this.socketService.socket.on('API::newBlock', () => {
        //     if (!this.rpcService.isApiRPC) return;
        //     this.updateBalances();
        // });
    }

    async updateBalances() {
        const addressesArray = this.authService.listOfallAddresses;
        for (let i = 0; i < addressesArray?.length; i++) {
            const address = addressesArray[i]?.address;
            await this.updateCoinBalanceForAddressFromUnspents(address);
            await this.updateTokensBalanceForAddress(address);
        }
    }

    private async updateCoinBalanceForAddressFromUnspents(address: string) {
        const coinBalanceObjRes = await this.getCoinBalanceObjForAddress(address);
        if (coinBalanceObjRes.error || !coinBalanceObjRes.data) {
            this.toastrService.error(coinBalanceObjRes.error || `Error with updating balances: ${address}`, 'Error');
            return;
        }
        const { confirmed, unconfirmed } = coinBalanceObjRes.data;
        const coinObj = { confirmed, unconfirmed };
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
        if (tokensBalanceArrRes.error || !tokensBalanceArrRes.data) {
            this.toastrService.error(tokensBalanceArrRes.error || `Error with updating balances`, 'Error');
            return;
        }
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
        const confirmed = parseFloat(_confirmed.toFixed(5));
        const unconfirmed = parseFloat(_unconfirmed.toFixed(5));
        return {data: { confirmed, unconfirmed } };
    }

    private async getTokensBalanceArrForAddress(address: string) {
        if (!address) return { error: 'No address provided for updating the balance' };
        const balanceRes = await this.rpcService.rpc('tl_getallbalancesforaddress', [address]);
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

    private async getTokenNameById(id: number) {
        const gpRes = await this.rpcService.rpc('tl_getproperty', [id]);
        if (gpRes.error || !gpRes.data?.name) return `ID_${id}`;
        return gpRes.data.name;
    }

    restartBalance() {
        this._allBalancesObj = {};
    }
}
