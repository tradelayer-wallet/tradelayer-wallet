import { ThrowStmt } from "@angular/compiler";
import { Injectable } from "@angular/core";
import { Router } from "@angular/router";
import { ToastrService } from "ngx-toastr";
import { Subject } from "rxjs";
import { encrypt, decrypt } from '../../utils/crypto.util'

import { ApiService } from "./api.service";
import { DialogService } from "./dialogs.service";
import { RpcService, TNETWORK } from "./rpc.service";
import { WindowsService } from "./windows.service";

const defaultWalletObj: IWalletObj = {
    main: [],
    spot: [],
    futures: [],
    reward: [],
    liquidity: [],
};

export interface IKeyPair {
    address: string;
    pubkey: string;
    privkey: string;
    wif: string;
}

export enum EAddress {
    MAIN = 'MAIN',
    SPOT = 'SPOT',
    FUTURES = 'FUTURES',
    REWARD = 'REWARD',
};

export interface IRawWalletObj {
    mnemonic: string;
    network: TNETWORK;
    derivatePaths: {
        main: string[];
        spot: string[];
        futures: string[];
        reward: string[];
        liquidity: string[];
    },
}

export interface IWalletObj {
    main: IKeyPair[];
    spot: IKeyPair[];
    futures: IKeyPair[];
    reward: IKeyPair[];
    liquidity: IKeyPair[];
};
const initDPath = "m/49/60/"; // 49 for bip49; 60 for tradelayer code

@Injectable({
    providedIn: 'root',
})

export class AuthService {
    private defaultWalletObjRaw: IRawWalletObj = {
        mnemonic: '',
        network: this.rpcService.NETWORK,
        derivatePaths: {
            main: [],
            spot: [],
            futures: [],
            reward: [],
            liquidity: [],
        }
    };
    updateAddressesSubs$ = new Subject<string[]>();

    private walletObjRaw: IRawWalletObj = JSON.parse(JSON.stringify(this.defaultWalletObjRaw));
    private _walletKeys: IWalletObj = JSON.parse(JSON.stringify(defaultWalletObj));
    private _activeMainKey: IKeyPair = this.walletKeys.main?.[0] || null;
    private _activeSpotKey: IKeyPair  = this.walletKeys.spot?.[0] || null;
    private _activeFuturesKey: IKeyPair  = this.walletKeys.futures?.[0] || null;

    public encKey: string = '';
    savedFromUrl: string = '';
    mnemonic: string = '';

    private walletLabel: string = 'tl-wallet';
    private _walletAddresses: string[] = [];
    constructor(
        private router: Router,
        private dialogService: DialogService,
        private apiService: ApiService,
        private toastrService: ToastrService,
        private rpcService: RpcService,
        private windowsService: WindowsService,
    ) {}

    get isLoggedIn() {
        return !!this.walletKeys.main.length;
    }

    get activeSpotKey() {
        return this._activeSpotKey || this.walletKeys.spot?.[0];
    }

    set activeSpotKey(value: IKeyPair) {
        this._activeSpotKey = value;
    }

    get activeFuturesKey() {
        return this._activeFuturesKey || this.walletKeys.futures?.[0];
    }

    set activeFuturesKey(value: IKeyPair) {
        this._activeFuturesKey = value;
    }

    get activeMainKey() {
        return this._activeMainKey || this.walletKeys.main?.[0];
    }

    set activeMainKey(value: IKeyPair) {
        this._activeMainKey = value;
    }

    get keysApi() {
        return this.apiService.keysApi;
    }

    get reLayerApi() {
        return this.apiService.tlApi;
    }

    get walletKeys() {
        return this._walletKeys;
    }

    get listOfallAddresses() {
        const all = (Object.values(this.walletKeys) as any).flat() as IKeyPair[];
        return all.filter((k, i) => all.findIndex(e => e.address === k.address) === i);
    }

    get walletAddresses() {
        return this._walletAddresses;
    }

    set walletAddresses(value: string[]) {
        this._walletAddresses = value;
        this.updateAddressesSubs$.next(value);
    }

    get isAbleToRpc() {
        return this.rpcService.isAbleToRpc;
    }

    // The node wallet holds the keys and signs: key pairs carry no privkey or wif.
    getWifByAddress(address: string) {
        return this.listOfallAddresses?.find(e => e.address === address)?.wif || '';
    }

    private async getKeyPairFromWallet(address: string): Promise<IKeyPair | null> {
        const existing = this.listOfallAddresses.find(e => e.address === address);
        if (existing) return existing;
        const res = await this.rpcService.rpc('getaddressinfo', [address]);
        const pubkey = res.data?.pubkey || res.data?.embedded?.pubkey;
        if (res.error || !pubkey) {
            console.log(`getaddressinfo: no pubkey for ${address}: ${res.error || 'not available'}`);
            return null;
        }
        return { address, pubkey, privkey: '', wif: '' };
    }

    // Every node-wallet address is a main, spot and futures key.
    private async updateWalletKeys(addresses: string[]) {
        const keys: IKeyPair[] = [];
        for (const address of addresses) {
            const keyPair = await this.getKeyPairFromWallet(address);
            if (keyPair) keys.push(keyPair);
        }
        this._walletKeys = { ...this._walletKeys, main: keys, spot: [...keys], futures: [...keys] };
    }

    // `retried` bounds the create/load fallback to one attempt: a node that cannot create the
    // wallet answers -18 again and must not recurse forever.
    async getAddressesFromWallet(retried: boolean = false) {
        try {
            if (!this.isAbleToRpc) return;
            const res = await this.rpcService.rpc('getaddressesbylabel', [this.walletLabel]);
            if (res.EECode === -18) {
                if (retried) throw new Error(res.error || 'getaddressesbylabel: wallet not available');
                try {
                    await this.rpcService.rpc('createwallet', [this.walletLabel]);
                    await this.rpcService.rpc('loadwallet', [this.walletLabel]);
                } catch (error) {
                    console.log(error);
                }
                await this.getAddressesFromWallet(true);
                return;
            }

            if (res.EECode === -11) {
                await this.updateWalletKeys([]);
                this.walletAddresses = [];
                return;
            }

            if (!res.data || res.error) throw new Error(res.error || 'getaddressesbylabel: Error with getting addresses');

            const _addresses = Object.keys(res.data);
            const addresses = _addresses?.length ? _addresses : [];
            await this.updateWalletKeys(addresses);
            this.walletAddresses = addresses;
        } catch (error: any) {
            // this.toastrService.error(error.message || error, 'Error');
        }
    }

    async addKeyPair(type: EAddress = EAddress.MAIN): Promise<boolean> {
        try {
            // Creates and loads the node wallet first when it does not exist yet (-18).
            await this.getAddressesFromWallet();
            const res = await this.rpcService.rpc('getnewaddress', [this.walletLabel]);
            if (res.error || !res.data) throw new Error(res.error || 'getnewaddress: Error with creating an address');
            await this.getAddressesFromWallet();
            const keyPair = this.listOfallAddresses.find(e => e.address === res.data);
            if (keyPair && type === EAddress.SPOT) this.activeSpotKey = keyPair;
            if (keyPair && type === EAddress.FUTURES) this.activeFuturesKey = keyPair;
            return true;
        } catch (error: any) {
            this.toastrService.error(error?.message || 'Undefined Error');
            throw (error);
        }
    }



    logout() {

    }
}
