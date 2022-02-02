import { Injectable } from "@angular/core";
import { ToastrService } from "ngx-toastr";
import { AddressService } from "./address.service";
import { RpcService } from "./rpc.service";
import { SocketService } from "./socket.service";

@Injectable({
    providedIn: 'root',
})

export class RewardService {
    autoClaimAddresses: string[] = [];
    registeredList: string[] = [];
    waitingList: string[] = [];

    constructor (
        private addressService: AddressService,
        private socketService: SocketService,
        private rpcService: RpcService,
        private toastrService: ToastrService,
    ) {
        this.startBlockChecking();
    }

    get rewardAddresses() {
        return this.addressService.rewardAddresses;
    }

    get activeKeyPair() {
        return this.addressService.activeKeyPair;
    }

    startBlockChecking() {
        this.checkIfWin();
        this.checkRegisteredAddresses();
        this.socketService.socket.on('newBlock', (block) => {
            this.waitingList = [];
           this.checkIfWin();
           this.checkRegisteredAddresses();
        })
    }

    private async checkRegisteredAddresses() {
        const lnraRes = await this.rpcService.rpc('tl_listnodereward_addresses');
        if (lnraRes.error || !lnraRes.data) {
            this.toastrService.error(lnraRes.error || 'Error With getting registered Addresses', "Error")
            return;
        } else {
            const registeredAddresses = lnraRes.data.map((e: any) => e?.['address:']);
            this.registeredList = this.rewardAddresses
                .map(e => e.address)
                .filter(e => registeredAddresses.includes(e));
        }
    }
    async setAutoClaim(address: string) {
        const lnraRes = await this.rpcService.rpc('tl_listnodereward_addresses');
        if (lnraRes.error || !lnraRes.data) {
            this.toastrService.error(lnraRes.error || 'Error With getting registered Addresses', "Error")
            return;
        } else {
            if (this.autoClaimAddresses.includes(address)) {
                this.autoClaimAddresses = this.autoClaimAddresses.filter(e => e !== address);
            } else {
                this.autoClaimAddresses.push(address);
                this.checkIfWin();
            }
        }
    }

    async register(address: string) {
        if (!this.activeKeyPair?.address) return;

        const lnraRes = await this.rpcService.rpc('tl_listnodereward_addresses');
        if (lnraRes.error || !lnraRes.data) {
            this.toastrService.error(lnraRes.error || 'Error With getting registered Addresses', "Error")
            return;
        } else {
            if (lnraRes.data.map((e: any) => e?.['address:'] || []).includes(address)) {
                this.toastrService.warning('This Address is already registered', "Warning")
            } else {
                const setFeeRes = await this.rpcService.setEstimateFee();
                if (!setFeeRes.data || setFeeRes.error) return;

                const snaRes = await this.rpcService.rpc('tl_submit_nodeaddress', [this.activeKeyPair?.address, address]);
                if (snaRes.error || !snaRes.data) {
                    this.toastrService.error(snaRes.error || 'Error With Resgistering address', "Error");
                } else {
                    this.toastrService.success(`${address} Registered For Node Reward`, "Success");
                    this.waitingList.push(address);
                }
            }
        }
    }

    checkIfWin() {
        if (!this.rewardAddresses?.length) return;
        this.autoClaimAddresses.forEach(async address => {
            const iawRes = await this.rpcService.rpc('tl_isaddresswinner', [address]);
            if (iawRes.error || !iawRes.data) {
                this.toastrService.error(iawRes.error || 'Check Winner Error', "Error");
            } else {
                if (iawRes.data?.result === 'true') {
                    const cnrREs = await this.rpcService.rpc('tl_claim_nodereward', [address]);
                    cnrREs.error || !cnrREs.data
                        ? this.toastrService.error(cnrREs.error || 'Error with Claiming Node Reward', "Error")
                        : this.toastrService.success('Node reward claimed', "Node Reward");
                }
            }
        });
    }
}
