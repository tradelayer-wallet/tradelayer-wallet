import { Injectable } from "@angular/core";
import { ToastrService } from "ngx-toastr";
import { RpcService } from "./rpc.service";
import { SocketService } from "./socket.service";

export interface IKeyPair {
    address: string;
    pubKey: string;
    privKey: string;
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

    constructor(
        private rpcService: RpcService,
        private toastrService: ToastrService,
        private socketService: SocketService,
    ) {
        this.handleSocketEvents();
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

    addMultisigAddress(multisig: IMultisigPair) {
        this.multisigPairs = [...this.multisigPairs, multisig];
    }

    removeMultisigAddress(multisig: IMultisigPair) {
        this.multisigPairs = this.multisigPairs.filter(e => e !== multisig);
    }

    addDecryptedKeyPair(pair: IKeyPair) {
        this.keyPairs = [...this.keyPairs, pair];
        this.activeKeyPair = pair;
    }

    removeAllKeyPairs() {
        this.multisigPairs = [];
        this.keyPairs = [];
        this.activeKeyPair = null;
    }

    private handleSocketEvents() {
        this.socketService.socket.on('newBlock', () => {
            if (this.activeAddressKYCStatus === EKYCStatus.PENDING) this.checkKycStatusForAddress();
        });
    }

    async checkKycStatusForAddress(_address?: string) {
        const address = _address || this.activeKeyPair?.address;
        if (!address) return EKYCStatus.DISABLED;
        const laRes = await this.rpcService.rpc('tl_list_attestation');
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
        const attRes = await this.rpcService.rpc('tl_attestation', [address, address]);
        if (attRes.error || !attRes.data) {
            const attErrorMEssage = 'Error with Self KYC Attestion'
            this.toastrService.error(attRes.error || attErrorMEssage, 'Error');
            return;
        }
        this.toastrService.success(`TX: ${attRes.data}`, 'KYC Transaction')
        this.allAttestations[address] = EKYCStatus.PENDING;
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
