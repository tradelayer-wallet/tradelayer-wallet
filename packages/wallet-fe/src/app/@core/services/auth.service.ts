import { Injectable } from "@angular/core";
import { Router } from "@angular/router";
import { ToastrService } from "ngx-toastr";
import { BehaviorSubject } from "rxjs";
import { encrypt, decrypt } from '../../utils/crypto.util'

import { ApiService } from "./api.service";
import { DialogService } from "./dialogs.service";
import { RpcService } from "./rpc.service";

const defaultWalletObj: IWalletObj = {
    main: [],
    spot: [],
    futures: [],
    reward: [],
    liquidity: [],
};

const defaultWalletObjRaw: IRawWalletObj = {
    mnemonic: '',
    derivatePaths: {
        main: [],
        spot: [],
        futures: [],
        reward: [],
        liquidity: [],
    }
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

@Injectable({
    providedIn: 'root',
})

export class AuthService {
    updateBalanceSubs$ = new BehaviorSubject(true);
    logoutSubs$ = new BehaviorSubject(true);

    private walletObjRaw: IRawWalletObj = JSON.parse(JSON.stringify(defaultWalletObjRaw));
    private _walletKeys: IWalletObj = JSON.parse(JSON.stringify(defaultWalletObj));
    private _activeMainKey: IKeyPair = this.walletKeys.main?.[0] || null;
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

    async register(pass: string) {
        const rawWalletObj = await this.keysApi.getNewWallet().toPromise() as
            { mnemonic: string, mainKeyPair: IKeyPair };
        const { mnemonic } = rawWalletObj;
        if (!mnemonic) return;
        this.walletObjRaw.mnemonic = mnemonic;
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
                const derivatePath = `1/0/${this.walletKeys.main.length}`;
                const mnemonic = this.walletObjRaw.mnemonic;
                if (!mnemonic) throw new Error("Not found mnemonic");
                const keyPair = await this.keysApi.getKeyPair(derivatePath, mnemonic).toPromise() as IKeyPair;
                // const importValid = await this.importWIF(keyPair);
                // if (!importValid) throw('Error with importing The Address');
                this.walletKeys.main.push(keyPair);
                this.walletObjRaw.derivatePaths.main.push(derivatePath);
            }
            this.updateBalanceSubs$.next(true);
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
            const { derivatePaths, mnemonic } = walletObjRaw;
            if (!mnemonic || !derivatePaths) throw new Error("Error with file decrypt. Code 2");
            const keyPairs = await this.keysApi.getKeyPairsFromLoginFile(derivatePaths, mnemonic).toPromise() as IWalletObj;
            // const importValid = await this.importWIFfromWalletObj(keyPairs)
            // if (!importValid) throw('Error with importing The Address');
            Object.entries(keyPairs)
                .forEach(entry => {
                    const [key, value] = entry as [string, IKeyPair[]];
                    value.forEach(kp => {
                        if (this.walletKeys.hasOwnProperty(key)) {
                            (this._walletKeys as any)[key].push(kp);
                        }
                    });
                });
            this.updateBalanceSubs$.next(true);
            this.saveEncKey(pass, false);
            this.router.navigateByUrl(this.savedFromUrl);
        } catch (error: any) {
            this.toastrService.error(error.message || 'Undefined Error');
        }
    }

    // async importWIF(keyPair: IKeyPair) {
    //     console.log(`IMPORT: ${keyPair.wif}`);
    //     const utxosApi = await this.reLayerApi.rpc('listunspent', [0, 999999999, [keyPair.address]])
    //         .toPromise()
    //         .then(res => res.data);

    //     const utxosLocal = await this.rpcService.rpc('listunspent', [0, 999999999, [keyPair.address]])
    //         .then(res => res.data);
    //     if (utxosApi.length > utxosLocal.length) {
    //         console.log('Need Sync');
    //         return false;
    //     }

    //     if (utxosApi.length < utxosLocal.length) {
    //         console.log('Something Goes Wrong');
    //         return false;
    //     }

    //     if (utxosApi.length === utxosLocal.length) return true;
    //     return false;
    // }

    // async importWIFfromWalletObj(waleltObj: IWalletObj) {
    //     const keyPairLists = (Object.values(this.walletKeys) as any)
    //     .flat() as IKeyPair[];
    //     for (let i = 0; i < keyPairLists.length; i++) {
    //         const keyPair = keyPairLists[i];
    //         console.log(`IMPORT WIF: ${keyPair.wif}`);
    //     }
    //     return true;
    // }

    logout() {
        this.dialogService.openEncKeyDialog(this.encKey);
        this._walletKeys = JSON.parse(JSON.stringify(defaultWalletObj));
        this.walletObjRaw = JSON.parse(JSON.stringify(defaultWalletObjRaw));
        this.encKey = '';
        this.router.navigateByUrl('login');
        this.logoutSubs$.next(true);
        this.updateBalanceSubs$.next(true);
    }

    private saveEncKey(pass: string, openDialog = true) {
        const walletString = JSON.stringify(this.walletObjRaw);
        this.encKey = encrypt(walletString, pass);
        if (openDialog) this.dialogService.openEncKeyDialog(this.encKey);
    }
}
