import { Injectable } from "@angular/core";
import { AddressService } from "./address.service";
import { RpcService } from "./rpc.service";
import { SocketService } from "./socket.service";
import { ToastrService } from "ngx-toastr";
import { ApiService } from "./api.service";
import { Position } from "./spot-services/spot-positions.service";

const minBlocksForBalanceConf: number = 1;
const emptyBalanceObj = {
    fiatBalance: {
        total: 0,
        confirmed: 0,
        unconfirmed: 0,
        locked: 0,
    },
    tokensBalance: [],
};

@Injectable({
    providedIn: 'root',
})


export class BalanceService {

    private _allBalancesObj: {
        [key: string]: {
            fiatBalance: {
                confirmed: number;
                unconfirmed: number;
                locked: number;
            };
            tokensBalance: {
                locked: number;
                name: string;
                propertyid: number;
                balance: number;
                reserved: number;
            }[];
        }
    } = {};

    constructor(
        private rpcServic: RpcService,
        private addressService: AddressService,
        private socketService: SocketService,
        private toastrService: ToastrService,
        private apiService: ApiService,
    ) {
        this.handleSocketEvents()
    }

    get selectedAddress() {
        return this.addressService.activeKeyPair?.address;
    }

    get ssApi() {
        return this.apiService.socketScriptApi;
    }

    get allBalances() {
        return this._allBalancesObj;
    }

    getTokensBalancesByAddress(_address?: string) {
        const address = _address || this.selectedAddress;
        if (!address) return [];
        
        return this._allBalancesObj?.[address]?.tokensBalance || [];
    }

    getFiatBalancesByAddress(_address?: string) {
        const address = _address || this.selectedAddress;
        if (!address) return emptyBalanceObj.fiatBalance;
        return this._allBalancesObj?.[address]?.fiatBalance || emptyBalanceObj.fiatBalance;
    }

    private handleSocketEvents() {
        this.socketService.socket.on('newBlock', (blockHeight) => {
            console.log(`New Block: ${blockHeight}`);
            this.updateBalances();
        });

        this.socketService.socket.on('opened-positions', (openedPositions: Position[]) => {
            this.updateLockedBalanceByOpenedPositions(openedPositions);
        });
    }

    private updateLockedBalanceByOpenedPositions(openedPositions: Position[]) {
        const myPositions = openedPositions.filter(p => p.address === this.selectedAddress);
        if (!myPositions) return;
        const lockedBalancesArray: { propIdForSale: number, locked: number }[] = [];
        myPositions.forEach(pos => {
            const { amount, price, propIdForSale, isBuy} = pos;
            const _locked = isBuy ? amount * price : amount;
            const locked = parseFloat(_locked.toFixed(5));
            const existing = lockedBalancesArray.find(e => e.propIdForSale === propIdForSale);
            existing
                ? existing.locked = parseFloat((existing.locked + locked).toFixed(5))
                : lockedBalancesArray.push({ propIdForSale, locked });
        });

        const fbLocked = lockedBalancesArray.find(lb => lb.propIdForSale === 999)?.locked || 0;
        this.updateFiatLockedBalance(fbLocked);

        this.getTokensBalancesByAddress().forEach(tb => {
            const tbLocked = lockedBalancesArray.find(lb => lb.propIdForSale === tb.propertyid)?.locked || 0;
            this.updateTokenLockedBalanceById(tbLocked, tb.propertyid);
        });
    }

    private updateTokenLockedBalanceById(lockedBalance: number, propid: number) {
        const tokenBalanceObj = this.getTokensBalancesByAddress().find(t => t.propertyid === propid);
        if (!tokenBalanceObj) return;
        tokenBalanceObj.locked = lockedBalance;
    }

    private updateFiatLockedBalance(lockedBalance: number) {
        this.getFiatBalancesByAddress().locked = lockedBalance;
    }

    async updateBalances(_address?: string) {
        const address = _address || this.selectedAddress;
        if (!address) return;
        await this.updateFiatBalanceForAddressFromUnspents(address);
        await this.updateTokensBalanceForAddress(address);
    }

    private async updateFiatBalanceForAddressFromUnspents(address: string) {
        const fiatBalanceObjRes = await this.getFiatBalanceObjForAddress(address);
        if (fiatBalanceObjRes.error || !fiatBalanceObjRes.data) {
            this.toastrService.error(fiatBalanceObjRes.error || `Error with updating balances`, 'Error');
            return;
        }
        const locked = this.getFiatBalancesByAddress(address)?.locked || 0;
        const { confirmed, unconfirmed } = fiatBalanceObjRes.data;
        const fiatObj = { confirmed, unconfirmed, locked };
        if (!this._allBalancesObj[address]) this._allBalancesObj[address] = emptyBalanceObj;
        this._allBalancesObj[address].fiatBalance = fiatObj;
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

    private async getFiatBalanceObjForAddress(address: string) {
        if (!address) return { error: 'No address provided for updating the balance' };
        const luResConfirmed = await this.rpcServic.rpc('listunspent', [minBlocksForBalanceConf, 999999999, [address]]);
        if (luResConfirmed.error || !luResConfirmed.data) return { error: luResConfirmed.error || 'Undefined Error' };
        const luResUnconfirmed = await this.rpcServic.rpc('listunspent', [0, minBlocksForBalanceConf - 1, [address]]);
        if (luResUnconfirmed.error || !luResUnconfirmed.data) return { error: luResUnconfirmed.error || 'Undefined Error' };

        const _confirmed: number = luResConfirmed.data.map((e: any) => e.amount).reduce((a: number, b: number) => a + b, 0);
        const _unconfirmed: number = luResUnconfirmed.data.map((e: any) => e.amount).reduce((a: number, b: number) => a + b, 0);
        const confirmed = parseFloat(_confirmed.toFixed(5));
        const unconfirmed = parseFloat(_unconfirmed.toFixed(5));
        return {data: { confirmed, unconfirmed } };
    }

    private async getTokensBalanceArrForAddress(address: string) {
        if (!address) return { error: 'No address provided for updating the balance' };
        const balanceRes = await this.rpcServic.rpc('tl_getallbalancesforaddress', [address]);
        if (!balanceRes.data || balanceRes.error) return { data: [] };
        try {
            const promisesArray = (balanceRes.data as { propertyid: number, balance: string, reserved: string }[])
                .map(async (token) => ({ ...token, name: await this.getTokenNameById(token.propertyid)}));
            const arr = await Promise.all(promisesArray);
            const data = arr.map((t) => {
                const locked = this.getTokensBalancesByAddress()?.find(tb => tb.propertyid === t.propertyid)?.locked || 0;
                const balObj = {
                    ...t, 
                    balance: parseFloat(t.balance), 
                    reserved: parseFloat(t.reserved),
                    locked,
                };
                return balObj;
            });
            return { data };
        } catch (error: any) {
            return { error: `Error with getting tokens Balance` };
        }
    }

    private async getTokenNameById(id: number) {
        const gpRes = await this.rpcServic.rpc('tl_getproperty', [id]);
        if (gpRes.error || !gpRes.data?.name) return `ID_${id}`;
        return gpRes.data.name;
    }

    async withdraw(optionsObj: { fromAddress: string, toAddress: string, amount: number, propId: number }) {
        const { fromAddress, toAddress, amount, propId } = optionsObj;
        if (propId === 999) {
            const res = await this.ssApi.withdraw(fromAddress, toAddress, amount).toPromise();
            return res;
        } else {
            const res = await this.rpcServic.rpc('tl_send', [fromAddress, toAddress, propId, amount.toString()]);
            return res;
        }

    }

    restartBalance() {
        this._allBalancesObj = {};
    }
}
