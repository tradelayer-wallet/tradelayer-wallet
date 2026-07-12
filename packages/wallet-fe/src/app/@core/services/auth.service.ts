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
    LIQUIDITY = 'LIQUIDITY',
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
    private walletBootstrapRetryHandle: ReturnType<typeof setTimeout> | null = null;
    private walletBootstrapRetryAttempts: number = 0;
    private readonly walletBootstrapRetryLimit = 12;
    public walletLoaded: boolean = false;


    public encKey: string = '';
    savedFromUrl: string = '';
    mnemonic: string = '';

    public walletLabel: string = 'tl-wallet';
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
        return this.walletAddresses
    }

    get walletAddresses() {
        return this._walletAddresses;
    }

    get derivedWalletAddresses() {
        return this.getLocallyDerivedAddresses();
    }

    set walletAddresses(value: string[]) {
        this._walletAddresses = value;
        this.updateAddressesSubs$.next(value);
    }

    get isAbleToRpc() {
        return this.rpcService.isAbleToRpc;
    }

    get isWalletBootstrapInProgress() {
        return this.walletInitInProgress;
    }

    async loadWallet() {
        try {
            console.log("Loading wallet...");
            const walletInfo = await this.rpcService.rpc('getwalletinfo', [], this.walletLabel);

            if (walletInfo.error) {
                console.error("Error loading wallet:", walletInfo.error);
                return;
            }

            this.walletLoaded = true;
            console.log('Wallet bootstrap: walletLoaded=true');

            console.log("Wallet loaded successfully.");

            // Trigger encryption or decryption prompt if needed
            await this.dialogService.triggerWalletEncryption(walletInfo.data);
        } catch (error) {
            console.error("Failed to load wallet:", error);
        }
    }

    private clearWalletBootstrapRetry() {
        if (this.walletBootstrapRetryHandle) {
            clearTimeout(this.walletBootstrapRetryHandle);
            this.walletBootstrapRetryHandle = null;
        }
        this.walletBootstrapRetryAttempts = 0;
    }

    private scheduleWalletBootstrapRetry() {
        if (this.walletBootstrapRetryHandle) {
            return;
        }
        if (this.walletBootstrapRetryAttempts >= this.walletBootstrapRetryLimit) {
            console.warn('Wallet address bootstrap retry limit reached; giving up until RPC is ready.');
            return;
        }
        this.walletBootstrapRetryAttempts += 1;
        this.walletBootstrapRetryHandle = setTimeout(() => {
            this.walletBootstrapRetryHandle = null;
            void this.getAddressesFromWallet();
        }, 2000);
    }

    async getAddressesFromWallet(): Promise<string[] | void> {
        if (this.walletInitInProgress) {
            console.log("Wallet initialization in progress, skipping...");
            return;
        }

        try {
            this.walletInitInProgress = true;
            console.log('Wallet bootstrap: begin');

            const localWalletAddresses = this.getLocallyDerivedAddresses();
            if (localWalletAddresses.length) {
                console.log(`Wallet bootstrap: using ${localWalletAddresses.length} locally derived addresses`);
                this.walletAddresses = localWalletAddresses;
                await this.syncWatchOnlyAccounts('local-derived-bootstrap');
                this.walletLoaded = true;
                this.clearWalletBootstrapRetry();
                return localWalletAddresses;
            }

            if (!this.isAbleToRpc) {
                console.log('RPC not ready yet, queueing wallet address bootstrap retry...');
                this.scheduleWalletBootstrapRetry();
                return;
            }

            // Check if the wallet is already loaded
            const loadedWallets = await this.rpcService.rpc('listwallets', [], this.walletLabel);
            if (loadedWallets?.data?.includes(this.walletLabel)) {
                console.log(`Wallet ${this.walletLabel} already loaded.`);
            }

            if (!this.isAbleToRpc) return;
            const res = await this.rpcService.rpc('getaddressesbylabel', [this.walletLabel], this.walletLabel);

            if (res.EECode === -18) { // Wallet not found
                console.log("Wallet not found, attempting to create/load...");
                await this.rpcService.rpc('createwallet', [this.walletLabel], this.walletLabel);
                await this.rpcService.rpc('loadwallet', [this.walletLabel], this.walletLabel);
            } else if (res.EECode === -11) { // Wallet unloaded
                console.log("Wallet unloaded, attempting to load...");
                await this.rpcService.rpc('loadwallet', [this.walletLabel], this.walletLabel);
            } else if (res.error && !this.isMissingLabelError(res)) {
                throw new Error(res.error || 'Error retrieving wallet addresses');
            }

            const addresses = await this.collectWalletAddresses();
            this.walletAddresses = addresses?.length ? addresses : [];
            console.log(`Wallet bootstrap: collected ${this.walletAddresses.length} addresses`);
            await this.syncWatchOnlyAccounts('rpc-bootstrap');
            void this.loadWallet();
            this.clearWalletBootstrapRetry();
        } catch (error) {
            console.error("Error during wallet initialization:", error);
            this.scheduleWalletBootstrapRetry();
        } finally {
            this.walletInitInProgress = false;
            console.log('Wallet bootstrap: end');
        }
	}

    private async collectWalletAddresses(): Promise<string[]> {
        const orderedAddresses: string[] = [];
        const seen = new Set<string>();

        const pushAddress = (address: string) => {
            const normalizedAddress = String(address || '').trim();
            if (!normalizedAddress || seen.has(normalizedAddress)) {
                return;
            }
            seen.add(normalizedAddress);
            orderedAddresses.push(normalizedAddress);
        };

        const labelCandidates = new Set<string>();
        if (this.walletLabel) {
            labelCandidates.add(this.walletLabel);
        }

        const labelsRes = await this.rpcService.rpc('listlabels');
        if (!labelsRes?.error && Array.isArray(labelsRes?.data)) {
            labelsRes.data.forEach((label: string) => {
                const normalizedLabel = String(label || '').trim();
                if (normalizedLabel) {
                    labelCandidates.add(normalizedLabel);
                }
            });
        }

        for (const label of labelCandidates) {
            const addressesByLabelRes = await this.rpcService.rpc('getaddressesbylabel', [label], this.walletLabel);
            if (addressesByLabelRes?.error || !addressesByLabelRes?.data) {
                continue;
            }
            Object.keys(addressesByLabelRes.data || {}).forEach(pushAddress);
        }

        const unspentRes = await this.rpcService.rpc('listunspent', [0, 999999999], this.walletLabel);
        if (!unspentRes?.error && Array.isArray(unspentRes?.data)) {
            unspentRes.data.forEach((utxo: any) => pushAddress(utxo?.address));
        }

        return orderedAddresses;
    }

    private isMissingLabelError(res: any): boolean {
        const message = String(res?.error || '').toLowerCase();
        return message.includes('no addresses with label');
    }

    private getLocallyDerivedAddresses(): string[] {
        const addresses = ([] as IKeyPair[])
            .concat(
                ...(Object.keys(this.walletKeys) as (keyof IWalletObj)[])
                    .map((key) => this.walletKeys[key] || [])
            )
            .map((kp: IKeyPair) => String(kp?.address || '').trim())
            .filter((address: string) => !!address);
        return Array.from(new Set(addresses));
    }

    private syncLocalWalletAddresses() {
        const addresses = this.getLocallyDerivedAddresses();
        if (addresses.length) {
            this.walletAddresses = addresses;
            this.walletLoaded = true;
        }
    }

    async register(pass: string) {
        if (!this.apiService.apiUrl) {
            this.toastrService.error('Please Frist select API server', 'Error');
            const serversWindow = this.windowsService.tabs.find(q => q.title === 'Servers');
            if (serversWindow) this.windowsService.toggleTab(serversWindow, false);
            return;
        }
        const rawWalletObj = await this.keysApi.getNewWallet().toPromise() as
            { mnemonic: string, mainKeyPair: IKeyPair };
        const { mnemonic } = rawWalletObj;
        if (!mnemonic) return;
        this.walletObjRaw.mnemonic = mnemonic;
        this.walletObjRaw.network = this.rpcService.NETWORK;
        await this.addKeyPair(EAddress.MAIN, pass);
        this.router.navigateByUrl(this.savedFromUrl);

        if (this.rpcService.NETWORK?.endsWith('TEST') && this.activeMainKey?.address) {
            const fundRes = await this.reLayerApi.fundTestnetAddress(this.activeMainKey.address).toPromise();
            if (fundRes.error || !fundRes.data) {
                this.toastrService.warning(fundRes.error, 'Faucet Error');
            } else {
                this.toastrService.success(`${this.activeMainKey?.address} was Fund with small amount tLTC`, 'Testnet Faucet')
            }
        }
    }

    async loginWithMnemonics(words: string[], pass: string) {
        if (!this.apiService.apiUrl) {
            this.toastrService.error('Please Frist select API server', 'Error');
            const serversWindow = this.windowsService.tabs.find(q => q.title === 'Servers');
            if (serversWindow) this.windowsService.toggleTab(serversWindow, false);
            return;
        }
        try {
            const mnemonic = words.join(' ');
            if (!mnemonic) return;
            this.walletObjRaw.mnemonic = mnemonic;
            this.walletObjRaw.network = this.rpcService.NETWORK;
            await this.addKeyPair(EAddress.MAIN, pass);
            this.router.navigateByUrl(this.savedFromUrl);
        } catch (error: any) {
            this.toastrService.error(error?.message || 'Undefined Error');
            this.walletObjRaw = JSON.parse(JSON.stringify(this.defaultWalletObjRaw));
            throw (error);
        }
    }

    async loginFromKeyFile(key: string, pass: string) {
        try {
            if (!this.apiService.apiUrl) {
                this.toastrService.error('Please Frist select API server', 'Error');
                const serversWindow = this.windowsService.tabs.find(q => q.title === 'Servers');
                if (serversWindow) this.windowsService.toggleTab(serversWindow, false);
                return;
            }
            const stringKeyPairObj = decrypt(key, pass);
            if (!stringKeyPairObj) throw new Error("Error with file decrypt. Code 1");
            const walletObjRaw = JSON.parse(stringKeyPairObj);
            this.walletObjRaw = walletObjRaw;
            const { derivatePaths, mnemonic, network } = walletObjRaw;
            if (!mnemonic || !derivatePaths) throw new Error("Error with file decrypt. Code 2");
            if (network !== this.rpcService.NETWORK) throw new Error(`This login only availble in network: ${network}`);
            const keyPairs = await this.keysApi.getKeyPairsFromLoginFile(derivatePaths, mnemonic).toPromise() as IWalletObj;

            const addresses = Object.values(keyPairs)
                .reduce((acc, el) => acc.concat(el), [] as IKeyPair[])
                .filter((q: any) => q.address)
                .map((q: any) => q.address);
            const checkAddressesRes = await this.validatePubkeys(addresses);
            if (checkAddressesRes.error || !checkAddressesRes.data?.isValid) throw new Error("Pubkeys not imported");

            Object.entries(keyPairs)
                .forEach(entry => {
                    const [key, value] = entry as [string, IKeyPair[]];
                    value.forEach(kp => {
                        if (this.walletKeys.hasOwnProperty(key)) {
                            (this._walletKeys as any)[key].push(kp);
                        }
                    });
                });
            this.syncLocalWalletAddresses();
            this.updateAddressesSubs$.next(this.listOfallAddresses as any);
            await this.syncWatchOnlyAccounts('keyfile-login');
            this.saveEncKey(pass, false);
            this.router.navigateByUrl(this.savedFromUrl);
        } catch (error: any) {
            this.toastrService.error(error.message || 'Undefined Error');
        }
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
                await this.sendPubKeyForImporting(keyPair.address, keyPair.pubkey);
            }

            if (type === EAddress.SPOT) {
                const derivatePath = initDPath + `2/0/` + this.walletKeys.spot.length;
                const mnemonic = this.walletObjRaw.mnemonic;
                if (!mnemonic) throw new Error("Not found mnemonic");
                const keyPair = await this.keysApi.getKeyPair(derivatePath, mnemonic).toPromise() as IKeyPair;
                this.walletKeys.spot.push(keyPair);
                this.walletObjRaw.derivatePaths.spot.push(derivatePath);
                await this.sendPubKeyForImporting(keyPair.address, keyPair.pubkey);
            }

            if (type === EAddress.FUTURES) {
                const derivatePath = initDPath + `3/0/` + this.walletKeys.futures.length;
                const mnemonic = this.walletObjRaw.mnemonic;
                if (!mnemonic) throw new Error("Not found mnemonic");
                const keyPair = await this.keysApi.getKeyPair(derivatePath, mnemonic).toPromise() as IKeyPair;
                this.walletKeys.futures.push(keyPair);
                this.walletObjRaw.derivatePaths.futures.push(derivatePath);
                await this.sendPubKeyForImporting(keyPair.address, keyPair.pubkey);
            }

            if (type === EAddress.REWARD) {
                const derivatePath = initDPath + `4/0/` + this.walletKeys.reward.length;
                const mnemonic = this.walletObjRaw.mnemonic;
                if (!mnemonic) throw new Error("Not found mnemonic");
                const keyPair = await this.keysApi.getKeyPair(derivatePath, mnemonic).toPromise() as IKeyPair;
                this.walletKeys.reward.push(keyPair);
                this.walletObjRaw.derivatePaths.reward.push(derivatePath);
                await this.sendPubKeyForImporting(keyPair.address, keyPair.pubkey);
            }

            this.syncLocalWalletAddresses();
            this.updateAddressesSubs$.next(this.listOfallAddresses as any);
            this.saveEncKey(password);
            return true;
        } catch (error: any) {
            this.toastrService.error(error?.message || 'Undefined Error');
            throw (error);
        }
    }

    private async sendPubKeyForImporting(address: string, pubkey: string) {
        console.log('[wallet] syncing watch-only account', { source: 'single-key', address, pubkey });
        const res = await this.reLayerApi.syncWatchOnly([{ address, pubkey }]).toPromise();
        console.log('[wallet] watch-only sync response', { source: 'single-key', address, ok: !!res?.data, error: res?.error, data: res?.data });
        if (!res.data || res.error) this.toastrService.error(res.error || 'Imdefomed', 'Import Pubkey Error');
    }

    private async syncWatchOnlyAccounts(source: string) {
        const accounts = this.getLocallyDerivedAccounts();
        if (!accounts.length) {
            console.log(`Wallet bootstrap: no locally derived accounts to sync (${source})`);
            return;
        }
        console.log(`Wallet bootstrap: syncing ${accounts.length} watch-only accounts (${source})`, accounts);
        const res = await this.reLayerApi.syncWatchOnly(accounts).toPromise();
        console.log('[wallet] watch-only sync response', { source, count: accounts.length, ok: !!res?.data, error: res?.error, data: res?.data });
        if (!res?.data || res.error) {
            this.toastrService.error(res?.error || 'Imdefomed', 'Watch-only Sync Error');
        }
    }

    private getLocallyDerivedAccounts(): Array<{ address: string; pubkey: string }> {
        const accounts: Array<{ address: string; pubkey: string }> = [];
        const seen = new Set<string>();
        (Object.keys(this.walletKeys) as (keyof IWalletObj)[]).forEach((bucket) => {
            (this.walletKeys[bucket] || []).forEach((kp) => {
                const address = String(kp?.address || '').trim();
                const pubkey = String(kp?.pubkey || '').trim();
                if (!address || !pubkey) return;
                const dedupeKey = `${address}|${pubkey}`;
                if (seen.has(dedupeKey)) return;
                seen.add(dedupeKey);
                accounts.push({ address, pubkey });
            });
        });
        return accounts;
    }

    private async validatePubkeys(addresses: string[]) {
        try {
            const objRes: any = {};
            for (let i = 0; i < addresses.length; i++) {
                const address = addresses[i];
                const vaRes = await this.reLayerApi.rpc('validateaddress', [address]).toPromise();
                if (vaRes.error || !vaRes.data) throw new Error(`validatePubkeys: validateaddress: ${vaRes.error}`);
                objRes[address] = {
                    pubkeyImported: !!vaRes.data.pubkey,
                    valid: !!vaRes.data.isvalid,
                }
            }
            const isValid = Object.values(objRes).every((q: any) => q.pubkeyImported);
            return { data: { objRes, isValid } };
        } catch (error: any) {
            return { error: error.message };
        }
    }

    private saveEncKey(pass: string, openDialog = true) {
        const walletString = JSON.stringify(this.walletObjRaw);
        this.encKey = encrypt(walletString, pass);
        if (openDialog) this.dialogService.openEncKeyDialog(this.encKey);
    }


    logout() {

    }
}
