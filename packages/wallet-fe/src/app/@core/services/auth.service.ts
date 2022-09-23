import { Injectable } from "@angular/core";
import { Router } from "@angular/router";
import { ToastrService } from "ngx-toastr";
import { Subject } from "rxjs";
import { encrypt, decrypt } from '../../utils/crypto.util'

import { ApiService } from "./api.service";
import { DialogService } from "./dialogs.service";
import { RpcService, TNETWORK } from "./rpc.service";

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
    updateAddressesSubs$ = new Subject<IKeyPair[]>();

    private walletObjRaw: IRawWalletObj = JSON.parse(JSON.stringify(this.defaultWalletObjRaw));
    private _walletKeys: IWalletObj = JSON.parse(JSON.stringify(defaultWalletObj));
    private _activeMainKey: IKeyPair = this.walletKeys.main?.[0] || null;
    private _activeSpotKey: IKeyPair  = this.walletKeys.spot?.[0] || null;
    public encKey: string = '';
    savedFromUrl: string = '';
    mnemonic: string = '';

    constructor(
        private router: Router,
        private dialogService: DialogService,
        private apiService: ApiService,
        private toastrService: ToastrService,
        private rpcService: RpcService,
    ) {}

    get isLoggedIn() {
        return !!this.walletKeys.main.length;
    }

    get activeSpotKey() {
        return this._activeSpotKey || this.walletKeys.spot?.[0];
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
        return (Object.values(this.walletKeys) as any)
            .flat() as IKeyPair[];
    }

    getWifByAddress(address: string) {
        return this.listOfallAddresses?.find(e => e.address === address)?.wif || null;
    }

    async register(pass: string) {
        const rawWalletObj = await this.keysApi.getNewWallet().toPromise() as
            { mnemonic: string, mainKeyPair: IKeyPair };
        const { mnemonic } = rawWalletObj;
        if (!mnemonic) return;
        this.walletObjRaw.mnemonic = mnemonic;
        this.walletObjRaw.network = this.rpcService.NETWORK;
        await this.addKeyPair(EAddress.MAIN, pass);
        this.router.navigateByUrl(this.savedFromUrl);
    }

    async addKeyPair(type: EAddress, password: string): Promise<boolean> {
        try {
            if (this.encKey) {
                const validPassowrd = !!decrypt(this.encKey, password);
                if (!validPassowrd) throw new Error("Wrong Password");
            }
            if (type === EAddress.MAIN) {
                const derivatePath = initDPath + `1/0/` + this.walletKeys.main.length;
                const mnemonic = this.walletObjRaw.mnemonic;
                if (!mnemonic) throw new Error("Not found mnemonic");
                const keyPair = await this.keysApi.getKeyPair(derivatePath, mnemonic).toPromise() as IKeyPair;
                this.walletKeys.main.push(keyPair);
                this.walletObjRaw.derivatePaths.main.push(derivatePath);
            }

            if (type === EAddress.SPOT) {
                const derivatePath = initDPath + `2/0/` + this.walletKeys.spot.length;
                const mnemonic = this.walletObjRaw.mnemonic;
                if (!mnemonic) throw new Error("Not found mnemonic");
                const keyPair = await this.keysApi.getKeyPair(derivatePath, mnemonic).toPromise() as IKeyPair;
                this.walletKeys.spot.push(keyPair);
                this.walletObjRaw.derivatePaths.spot.push(derivatePath);
            }
            // add more types
            this.updateAddressesSubs$.next(this.listOfallAddresses);
            this.saveEncKey(password);
            return true;
        } catch (error: any) {
            this.toastrService.error(error?.message || 'Undefined Error');
            throw (error);
        }
    }

    async loginFromKeyFile(key: string, pass: string) {
        try {
            const stringKeyPairObj = decrypt(key, pass);
            if (!stringKeyPairObj) throw new Error("Error with file decrypt. Code 1");
            const walletObjRaw = JSON.parse(stringKeyPairObj);
            this.walletObjRaw = walletObjRaw;
            const { derivatePaths, mnemonic, network } = walletObjRaw;
            if (!mnemonic || !derivatePaths) throw new Error("Error with file decrypt. Code 2");
            if (network !== this.rpcService.NETWORK) throw new Error(`This login only availble in network: ${network}`);
            const keyPairs = await this.keysApi.getKeyPairsFromLoginFile(derivatePaths, mnemonic).toPromise() as IWalletObj;
            Object.entries(keyPairs)
                .forEach(entry => {
                    const [key, value] = entry as [string, IKeyPair[]];
                    value.forEach(kp => {
                        if (this.walletKeys.hasOwnProperty(key)) {
                            (this._walletKeys as any)[key].push(kp);
                        }
                    });
                });
            this.updateAddressesSubs$.next(this.listOfallAddresses);
            this.saveEncKey(pass, false);
            this.router.navigateByUrl(this.savedFromUrl);
        } catch (error: any) {
            this.toastrService.error(error.message || 'Undefined Error');
        }
    }

    logout() {
        this.dialogService.openEncKeyDialog(this.encKey);
        this._walletKeys = JSON.parse(JSON.stringify(defaultWalletObj));
        this.walletObjRaw = JSON.parse(JSON.stringify(this.defaultWalletObjRaw));
        this.encKey = '';
        this.savedFromUrl = '';
        this.router.navigateByUrl('login');
        this.updateAddressesSubs$.next(this.listOfallAddresses);
    }

    private saveEncKey(pass: string, openDialog = true) {
        const walletString = JSON.stringify(this.walletObjRaw);
        this.encKey = encrypt(walletString, pass);
        if (openDialog) this.dialogService.openEncKeyDialog(this.encKey);
    }
}
