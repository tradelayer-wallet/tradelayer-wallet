import { Injectable } from "@angular/core";
import { ToastrService } from "ngx-toastr";
import { AuthService, IKeyPair } from "./auth.service";
import { RpcService } from "./rpc.service";
import { TxsService } from "./txs.service";

export interface IRewardKeyPair extends IKeyPair {
    isRegistered?: boolean | "PENDING";
    autoClaim?: boolean;
}

@Injectable({
    providedIn: 'root',
})

export class NodeRewardService {
    private _rewardAddresses: IRewardKeyPair[] = [];

    constructor(
        private rpcService: RpcService,
        private toastrService: ToastrService,
        private authService: AuthService,
        private txsService: TxsService,
    ) {}

    get rewardAddresses() {
        return this._rewardAddresses;
    }

    set rewardAddresses(value: IRewardKeyPair[]){
        this._rewardAddresses = value;
    }

    onInit() {
        this.authService.updateAddressesSubs$
            .subscribe(kp => {
                if (!kp.length) this.rewardAddresses = [];
                this.checkRegisteredAddresses();
            });

        this.rpcService.blockSubs$
            .subscribe(async (block) => {
                if (block.type !== "LOCAL") return;
                if (!this.rpcService.isCoreStarted || !this.rpcService.isSynced) return;
                await this.checkRegisteredAddresses(true);
                await this.checkWinners();
            });
    }

    async registerAddress(keyPair: IRewardKeyPair) {
        const lnraRes = await this.rpcService.rpc('tl_listnodereward_addresses');
        if (lnraRes.error || !lnraRes.data) {
            this.toastrService.error(lnraRes.error || 'Error With getting Reward registered Addresses', "Error")
            return;
        }
        const registeredAddresses = lnraRes.data.map((e: any) => e?.['address:']);
        if (registeredAddresses.includes(keyPair.address)) {
            this.toastrService.warning(`${keyPair.address} is already registered`, "Warning");
            this.checkRegisteredAddresses();
            return;
        }
        const payload = "007900";
        const address = keyPair.address;
        const res = await this.txsService.buildSingSendTx({
            fromKeyPair: { address },
            toKeyPair: { address },
            payload,
          });

          if (res.error || !res.data) {
            this.toastrService.error(res.error || 'Error With Resgistering address', "Error");
        } else {
            this.toastrService.success(`${keyPair.address} Registered For Node Reward`, "Success");
            keyPair.isRegistered = 'PENDING';
        }
    }

    async checkRegisteredAddresses(cleanPendings: boolean = false) {
        const lnraRes = await this.rpcService.rpc('tl_listnodereward_addresses');
        if (lnraRes.error || !lnraRes.data) {
            this.toastrService.error(lnraRes.error || 'Error With getting Reward registered Addresses', "Error")
            return;
        } else {
            const registeredAddresses = lnraRes.data.map((e: any) => e?.['address:']);
            this.rewardAddresses.forEach(q => {
                if (cleanPendings || q.isRegistered !== "PENDING") {
                    q.isRegistered = !!registeredAddresses.includes(q.address);
                }
            });
        }
    }

    async checkWinners() {
        const autoClaimAddresses = this.rewardAddresses.filter(q => q.autoClaim);
        if (autoClaimAddresses.length) {
            for (let i = 0; i < autoClaimAddresses.length; i++) {
                const address = autoClaimAddresses[i].address
                const iawRes = await this.rpcService.rpc('tl_isaddresswinner', [address]);
                if (iawRes.error || !iawRes.data) {
                    this.toastrService.error(iawRes.error || 'Check Winner Error', "Error");
                    await this.checkWinners();
                } else {
                    if (iawRes.data?.result === 'true') {
                        const payload = "007A00";
                        const cnrREs = await this.txsService.buildSingSendTx({
                            fromKeyPair: { address },
                            toKeyPair: { address },
                            payload,
                        });
                        if (cnrREs.error || !cnrREs.data) {
                            this.toastrService.error(cnrREs.error || 'Error with Claiming Node Reward', "Error")
                        } else {
                            this.toastrService.success('Node reward claimed', "Node Reward");
                            await this.checkWinners();
                        }
                    }
                }
            }
        }
    }
}
