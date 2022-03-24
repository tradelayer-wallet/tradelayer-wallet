import { Injectable } from "@angular/core";
import { ToastrService } from "ngx-toastr";
import { RpcService } from "./rpc.service";
import { SocketService } from "./socket.service";

export interface IKeyPair {
    address: string;
    pubKey: string;
    privKey: string;
    rewardAddress?: boolean;
    liquidity_provider?: boolean;
}

export interface IMultisigPair {
    address: string;
    redeemScript: string;
    nRequired?: number;
    nAllKeys?: number;
    keys?: string[];
}

export enum EKYCStatus { 
    ENABLED = 'Enabled',
    DISABLED = 'Disabled',
    PENDING = 'Pending',
};

@Injectable({
    providedIn: 'root',
})

export class AddressService {
    private _keyPairs: IKeyPair[] = [];
    private _activeKeyPair: IKeyPair | null = null;
    private allAttestations: { [address: string]: EKYCStatus } = {};
    private _multisigPairs: IMultisigPair[] = [];
    private _rewardAddresses: IKeyPair[] = [];
    private _maxNRewardAddresses: number = 5;
    private _liquidityAddresses: IKeyPair[] = [];

    constructor(
        private rpcService: RpcService,
        private toastrService: ToastrService,
        private socketService: SocketService,
    ) {
        this.handleSocketEvents();
    }

    get allAddresses() {
        return [
            ...this._keyPairs, 
            ...this._rewardAddresses, 
            ...this._liquidityAddresses,
        ];
    }

    get multisigPairs() {
        return this._multisigPairs;
    }

    set multisigPairs(value: IMultisigPair[]) {
        this._multisigPairs = value;
    }

    get keyPairs() {
        return this._keyPairs;
    }

    set keyPairs(value: IKeyPair[]) {
        this._keyPairs = value
    }

    get activeKeyPair() {
        return this._activeKeyPair;
    }

    set activeKeyPair(value: IKeyPair | null) {
        this.checkKycStatusForAddress(value?.address);
        this._activeKeyPair = value;
    }

    get activeAddressKYCStatus() {
        if (!this.activeKeyPair?.address) return EKYCStatus.DISABLED;
        const address = this.activeKeyPair.address;
        return this.allAttestations[address];
    }

    get liquidityAddressesKYCStatus() {
        if (!this.liquidityAddresses?.[0]?.address) return EKYCStatus.DISABLED;
        const address = this.liquidityAddresses[0].address;
        return this.allAttestations[address];
    }

    get rewardAddresses() {
        return this._rewardAddresses;
    }

    set rewardAddresses(value: IKeyPair[]) {
        this._rewardAddresses = value;
    }

    get maxNRewardAddresses() {
        return this._maxNRewardAddresses;
    }

    get liquidityAddresses() {
        return this._liquidityAddresses;
    }

    set liquidityAddresses(value: IKeyPair[]) {
        value.forEach(({ address }) => this.checkKycStatusForAddress(address));
        this._liquidityAddresses = value;
    }

    get isApiRPC() {
        return this.rpcService.isApiRPC;
    }

    addMultisigAddress(multisig: IMultisigPair) {
        this.multisigPairs = [...this.multisigPairs, multisig];
    }

    removeMultisigAddress(multisig: IMultisigPair) {
        this.multisigPairs = this.multisigPairs.filter(e => e !== multisig);
    }

    addDecryptedKeyPair(pair: IKeyPair, setActive: boolean = false) {
        this.keyPairs = [...this.keyPairs, pair];
        if (setActive) this.activeKeyPair = pair;
    }

    removeAllKeyPairs() {
        this.multisigPairs = [];
        this.keyPairs = [];
        this.rewardAddresses = [];
        this.liquidityAddresses = [];
        this.activeKeyPair = null;
    }

    private handleSocketEvents() {
        this.socketService.socket.on('newBlock-api', () => {
            if (!this.isApiRPC) return;
            if (this.activeAddressKYCStatus === EKYCStatus.PENDING) this.checkKycStatusForAddress();
        });

        this.socketService.socket.on('newBlock', () => {
            if (this.isApiRPC) return;
            if (this.activeAddressKYCStatus === EKYCStatus.PENDING) this.checkKycStatusForAddress();
        });
    }

    async checkKycStatusForAddress(_address?: string) {
        const address = _address || this.activeKeyPair?.address;
        if (!address) return EKYCStatus.DISABLED;
        const laRes = await this.rpcService.smartRpc('tl_list_attestation');
        if (laRes.error || !laRes.data) {
            this.toastrService.error('Error with getting KYC status', 'Error');
            this.allAttestations[address] = EKYCStatus.DISABLED;
            return this.allAttestations[address];
        }
        const selfAttStatus = laRes.data.some((o: { 'att sender': string, 'att receiver': string, kyc_id: number }) => 
            (o?.['att receiver'] === address && o?.['att sender'] === address && o.kyc_id === 0));
            this.allAttestations[address] = selfAttStatus ? EKYCStatus.ENABLED : EKYCStatus.DISABLED;
        return this.allAttestations[address];
    }

    async kycAddress(address: string) {
        await this.checkKycStatusForAddress(address);
        if (this.allAttestations[address] !== EKYCStatus.DISABLED) return;
        const setFeeRes = await this.rpcService.setEstimateFee();
        // if (!setFeeRes.data || setFeeRes.error) return;
        const attRes = this.isApiRPC
            ? await this.rpcService.localRpcCall('tl_attestation', [address, address]).toPromise()
            : await this.rpcService.rpc('tl_attestation', [address, address]);

        if (attRes.error || !attRes.data) {
            const attErrorMEssage = 'Error with Self KYC Attestion'
            this.toastrService.error(attRes.error || attErrorMEssage, 'Error');
            return;
        }
        this.toastrService.success(`TX: ${attRes.data}`, 'KYC Transaction')
        this.allAttestations[address] = EKYCStatus.PENDING;
    }

    async generateRewardAddresses() {
        if (this.rewardAddresses.length >= this.maxNRewardAddresses) return;
        for (let i = 0; i < this.maxNRewardAddresses; i++) {
            const keyPair = await this.generateNewKeyPair();
            if (keyPair) {
                keyPair.rewardAddress = true;
                this.addRewardAddress(keyPair);
            }
        }
    }

    addRewardAddress(keyPair: IKeyPair) {
        this.rewardAddresses = [...this.rewardAddresses, keyPair];
    }

    async generateLiquidityAddress() {
        const keyPair = await this.generateNewKeyPair();
        if (keyPair) {
            keyPair.liquidity_provider = true;
            this.addLiquidtyAddress(keyPair);
        }
    }

    addLiquidtyAddress(keyPair: IKeyPair) {
        this.liquidityAddresses = [...this.liquidityAddresses, keyPair];
    }

    async generateNewKeyPair() {
        const gnaRes = await this.rpcService.rpc('getnewaddress', ['tl-wallet']);
        if (gnaRes.error || !gnaRes.data) return null;
        const address = gnaRes.data;

        const dpkRes = await this.rpcService.rpc('dumpprivkey', [address]);
        if (dpkRes.error || !dpkRes.data) return null;
        const privKey = dpkRes.data;

        const vaRes = await this.rpcService.rpc('validateaddress', [address]);
        if (vaRes.error || !vaRes.data?.pubkey) return null;
        const pubKey = vaRes.data.pubkey;

        const keyPair: IKeyPair = { address, privKey, pubKey}
        return keyPair;
    }
}
