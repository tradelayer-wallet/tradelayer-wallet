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
        //console.log('inside isLoggedIn '+this.walletKeys.main.length)
        return !!this.walletKeys.main.length;
    }

    get activeSpotKey() {
        return this._activeSpotKey || this.walletKeys.spot?.[0];
    }

    get activeFuturesKey() {
        return this._activeFuturesKey || this.walletKeys.futures?.[0];
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
        //console.log('inside list of addresses checking keys '+JSON.stringify(this.walletKeys))
        return (Object.values(this.walletKeys) as any)
            .flat() as IKeyPair[];
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

    getWifByAddress(address: string) {
        return this.listOfallAddresses?.find(e => e.address === address)?.wif || null;
    }

    async getAddressesFromWallet() {
        try {
            if (!this.isAbleToRpc) return;
            const res = await this.rpcService.rpc('getaddressesbylabel', [this.walletLabel]);
            console.log('inside get addresses from wallet '+JSON.stringify(res))
            if (res.EECode === -18) {
                try {
                    await this.rpcService.rpc('createwallet', [this.walletLabel]);
                    await this.rpcService.rpc('loadwallet', [this.walletLabel]);
                } catch (error) {
                    console.log(error);
                }
                await this.getAddressesFromWallet();
                return;
            }

            if (res.EECode === -11) {
                console.log('res EE code 11 returning wallet []')
                await this.rpcService.rpc('loadwallet', [this.walletLabel]);

                return;
            }

            if (!res.data || res.error) throw new Error(res.error || 'getaddressesbylabel: Error with getting addresses');

            const _addresses = Object.keys(res.data);
            const addresses = _addresses?.length ? _addresses : [];
            this.walletAddresses = addresses;
        } catch (error: any) {
            // this.toastrService.error(error.message || error, 'Error');
        }
    }

    async addKeyPair(): Promise<boolean> {
        try {
            await this.rpcService.rpc('getnewaddress', [this.walletLabel]);
            await this.getAddressesFromWallet();
            return true;
        } catch (error: any) {
            this.toastrService.error(error?.message || 'Undefined Error');
            throw (error);
        }
    }



    logout() {

    }
}
