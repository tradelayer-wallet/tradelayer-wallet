import { Injectable } from "@angular/core";
import { Router } from "@angular/router";
import { ToastrService } from "ngx-toastr";
import { encrypt, decrypt } from '../../utils/crypto.util'

import { ApiService } from "./api.service";
import { BalanceService } from "./balance.service";
import { DialogService, DialogTypes } from "./dialogs.service";
import { LiquidityProviderService } from "./liquidity-provider.service";
import { SocketService } from "./socket.service";
import { DealerService } from "./spot-services/dealer.service";
import { SpotPositionsService } from "./spot-services/spot-positions.service";
import { TxsService } from "./spot-services/txs.service";

export interface IKeyPair {
    address: string;
    pubkey: string;
    privkey: string;
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
    private walletObjRaw: IRawWalletObj = {
        mnemonic: '',
        derivatePaths: {
            main: [],
            spot: [],
            futures: [],
            reward: [],
            liquidity: [],
        }
    };

    private walletKeys: IWalletObj = {
        main: [],
        spot: [],
        futures: [],
        reward: [],
        liquidity: [],
    };

    public encKey: string = '';
    savedFromUrl: string = '';
    mnemonic: string = '';

    constructor(
        private router: Router,
        private dialogService: DialogService,
        // private balanceService: BalanceService,
        private apiService: ApiService,
        // private txsService: TxsService,
        // private socketService: SocketService,
        // private spotPositionsService: SpotPositionsService,
        // private dealerService: DealerService,
        // private liquidityProviderService: LiquidityProviderService,
        private toastrService: ToastrService,
    ) {}

    get isLoggedIn() {
        return !!this.walletKeys?.main?.[0];
    }

    get activeMainKey() {
        return this.walletKeys?.main?.[0];
    }

    get keysApi() {
        return this.apiService.keysApi;
    }

    async register(pass: string) {
        const rawWalletObj = await this.keysApi.getNewWallet().toPromise() as
            { mnemonic: string, mainKeyPair: IKeyPair };
        const { mnemonic } = rawWalletObj;
        this.mnemonic = encrypt(mnemonic, pass);
        const mainDerivate = await this.addKeyPair(EAddress.MAIN, pass);
        if (!mainDerivate || !mnemonic) return;

        this.walletObjRaw.mnemonic = mnemonic;
        this.walletObjRaw.derivatePaths.main.push(mainDerivate);
        const walletString = JSON.stringify(this.walletObjRaw);
        this.encKey = encrypt(walletString, pass);
        this.dialogService.openEncKeyDialog(this.encKey);
        this.router.navigateByUrl(this.savedFromUrl);
    }

    async addKeyPair(type: EAddress, password: string): Promise<string | null> {
        if (type === EAddress.MAIN) {
            const derivatePath = `1/0/${this.walletKeys.main.length}`;
            const mnemonic = decrypt(this.mnemonic, password);
            if (!mnemonic) return null;
            const keyPair = await this.keysApi.getKeyPair(derivatePath, mnemonic).toPromise() as IKeyPair;
            this.walletKeys.main.push(keyPair);
            return derivatePath;
        }
        return null;
    }

    async loginFromKeyFile(key: string, pass: string) {
        try {
            const stringKeyPairObj = decrypt(key, pass);
            if (!stringKeyPairObj) throw new Error("Error with file decrypt. Code 1");
            const walletObjRaw = JSON.parse(stringKeyPairObj);
            this.walletObjRaw = walletObjRaw;
            const { derivatePaths, mnemonic } = walletObjRaw;
            if (!mnemonic || !derivatePaths) throw new Error("Error with file decrypt. Code 2");
            this.mnemonic = encrypt(mnemonic, pass);
            const keyPairs = await this.keysApi.getKeyPairsFromLoginFile(derivatePaths, mnemonic).toPromise() as IWalletObj;
            this.walletKeys = keyPairs;
            return null;
        } catch (error) {
            this.toastrService.error('error' || 'Undefined Error');
            return null;
        }
    }
    // async loginFromKeyFile(key: string, pass: string) {
    //     const res = ltcUtils.decryptKeyPair(key, pass) as (IKeyPair | IMultisigPair)[];
    //     if (!res?.length) {
    //         this.toastrService.error('Wrong Password or keyFile', 'Error');
    //         return;
    //     }

    //     const keyPairs = res.filter((e) => !('redeemScript' in e)) as IKeyPair[];

    //     if (!keyPairs?.length) return this.toastrService.error('Wrong keyFile', 'Error');
    //     for (const i in keyPairs) {
    //         const kp = keyPairs[i];
    //         if (!kp?.address || !kp?.pubKey || !kp?.privKey) {
    //             this.toastrService.error('Wrong keyFile', 'Error');
    //             return;
    //         }
    //         const vaRes = await this.rpcService.rpc('validateaddress', [kp.address]);

    //         if (vaRes.error || !vaRes.data) {
    //             this.toastrService.error('Error with validating wallet', 'Error');
    //             return;
    //         }

    //         if (!vaRes.data?.isvalid) {
    //             this.toastrService.error('The Address is not valid', 'Error');
    //             return;
    //         }
    
    //         if (vaRes.data?.isvalid && !vaRes.data?.ismine) {
    //             const ipkRes = await this.rpcService.rpc('importprivkey', [kp.privKey, "tl-wallet", false]);
    //         }
    //     }


    //     if (!this.rpcService.isOffline && !this.rpcService.isApiRPC) {
    //         const luRes = await this.rpcService.smartRpc('listunspent', [0, 999999999, [keyPairs[0]?.address]]);
    //         const scLuRes: any = await this.apiService.soChainApi.getTxUnspents(keyPairs[0]?.address).toPromise()
    //         if (luRes.error || !luRes.data || scLuRes.status !== "success" || !scLuRes.data) {
    //             this.toastrService.error('Unexpecter Error. Please try again!', 'Error');
    //             return;
    //         }
    //         if (luRes.data.length < scLuRes.data.txs?.length) {
    //             this.toastrService.info('There may be some incorect balance data', 'Not full UTXOs');
    //             // this.dialogService.openDialog(DialogTypes.RESCAN, { disableClose: true, data: { key, pass } });
    //             // return;
    //         }
    //     }

    //     if (this.rpcService.isOffline) {
    //         this.toastrService.info('There may be some incorect balance data', 'Offline wallet');
    //     }

    //     this.login(res);
    //     const allKeyParis = [
    //         ...this.addressService.keyPairs, 
    //         ...this.addressService.multisigPairs, 
    //         ...this.addressService.rewardAddresses,
    //         ...this.addressService.liquidityAddresses,
    //     ];
    //     this.encKey = ltcUtils.encryptKeyPair(allKeyParis, pass);
    //     return;
    // }

    login(pair: any) {
        // this.router.navigateByUrl(this.savedFromUrl);
        // this.addressService.keyPairs = [pair];
    }

    // private clearSpotData() {
    //     this.dealerService.myDealerTrades = [];
    //     this.spotPositionsService.openedPositions = [];
    //     this.txsService.pendingTxs = [];
    // }

    logout() {
        // this.clearSpotData();
        // this.addressService.removeAllKeyPairs();
        // this.balanceService.restartBalance();
        // if (this.liquidityProviderService.isLiquidityStarted) {
        //     const address = this.liquidityProviderService.liquidityAddresses?.[0].address;
        //     this.liquidityProviderService.stopLiquidityProviding(address);
        // }
        // this.encKey = '';
        // this.router.navigateByUrl('login');
        // this.socketService.socket.emit('logout');
    }
}
