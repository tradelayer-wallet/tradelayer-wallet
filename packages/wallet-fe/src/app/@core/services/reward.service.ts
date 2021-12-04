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
        this.socketService.socket.on('newBlock', (block) => {
           this.checkIfWin();
        })
    }

    async setAutoClaim(address: string) {
        const lnraRes = await this.rpcService.rpc('tl_listnodereward_addresses');
        if (lnraRes.error || !lnraRes.data) {
            this.toastrService.error(lnraRes.error || 'Error With getting registered Addresses', "Error")
            return;
        } else {
            if (!lnraRes.data.map((e: any) => e?.['address:'] || []).includes(address)) {
                this.toastrService.warning('This Address is not registered', "Warning")
            } else {
                this.autoClaimAddresses.push(address);
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
                const snaRes = await this.rpcService.rpc('tl_submit_nodeaddress', [this.activeKeyPair?.address, address]);
                snaRes.error || !snaRes.data
                    ? this.toastrService.error(snaRes.error || 'Error With Resgistering address', "Error")
                    : this.toastrService.success(`${address} Registered For Node Reward`, "Success");
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
