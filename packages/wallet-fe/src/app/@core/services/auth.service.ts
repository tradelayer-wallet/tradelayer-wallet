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
    private walletInitInProgress: boolean = false;
    public walletLoaded: boolean = false;
	public isWalletDecrypted: boolean = false;


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


	public resetDecryptionFlag() {
	    this.isWalletDecrypted = false;
	    console.log("Decryption flag reset to false on app startup.");
	}

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
        return this.walletAddresses
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

     async loadWallet() {
        try {
            console.log("Loading wallet...");
            const walletInfo = await this.rpcService.rpc('getwalletinfo');

            if (walletInfo.error) {
                console.error("Error loading wallet:", walletInfo.error);
                return;
            }

            this.walletLoaded = true;

            console.log("Wallet loaded successfully.");

            // Trigger encryption or decryption prompt if needed
            await this.dialogService.triggerWalletEncryption(walletInfo.data);
        } catch (error) {
            console.error("Failed to load wallet:", error);
        }
    }

	async getAddressesFromWallet() {
	 this.resetDecryptionFlag(); // Reset decryption status on startup
	    console.log('get address wallet init in progress?? '+this.walletInitInProgress)
	    if (this.walletInitInProgress) {
	        console.log("Wallet initialization in progress, skipping...");
	        return;
	    }

	    try {
	        this.walletInitInProgress = true;

	        if (!this.isAbleToRpc) return;

	        // Check if the wallet is already loaded
	        const loadedWallets = await this.rpcService.rpc('listwallets');
	        if (loadedWallets?.data?.includes(this.walletLabel)) {
	            console.log(`Wallet ${this.walletLabel} already loaded.`);
	            //return;
	        }

	        if (!this.isAbleToRpc) return;
	        const res = await this.rpcService.rpc('getaddressesbylabel', [this.walletLabel]);

	        if (res.EECode === -18) { // Wallet not found
	            console.log("Wallet not found, attempting to create/load...");
	            await this.rpcService.rpc('createwallet', [this.walletLabel]);
	            await this.rpcService.rpc('loadwallet', [this.walletLabel]);
	        } else if (res.EECode === -11) { // Wallet unloaded
	            console.log("Wallet unloaded, attempting to load...");
	            await this.rpcService.rpc('loadwallet', [this.walletLabel]);
	        } else if (!res.data || res.error) {
	            throw new Error(res.error || 'Error retrieving wallet addresses');
	        }

	        const addresses = Object.keys(res.data || {});
	        this.walletAddresses = addresses?.length ? addresses : [];
	        this.loadWallet()
	    } catch (error) {
	        console.error("Error during wallet initialization:", error);
	    } finally {
	        this.walletInitInProgress = false;
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
