import { Injectable } from "@angular/core";
import { ToastrService } from "ngx-toastr";
import { AuthService } from "./auth.service";
import { RpcService } from "./rpc.service";

@Injectable({
    providedIn: 'root',
})

export class AttestationService {
    private attestations: {address: string, isAttested: boolean | 'PENDING' }[] = [];
    constructor(
        private authService: AuthService,
        private rpcService: RpcService,
        private toastrService: ToastrService,
    ) { }

    onInit() {
        this.authService.logoutSubs$
            .subscribe(e => this.removeAll());

        this.authService.updateBalanceSubs$
            .subscribe(e => this.checkAllAtt());

        this.rpcService.blockSubs$
            .subscribe(() => this.checkPending());
    }

    private async checkAllAtt() {
        const addressesList = this.authService.listOfallAddresses
            .map(({ address }) => address)
            .filter(a => !this.attestations.map(e => e.address).includes(a));
        for (let i = 0; i < addressesList.length; i++) {
            const address = addressesList[i];
            await this.checkAttAddress(address);
        }
    }

    async checkAttAddress(address: string): Promise<boolean> {
        try {
            const aRes = await this.rpcService.rpc('tl_check_kyc', [address]);
            if (aRes.error || !aRes.data) throw new Error(aRes.error);
            const isAttested = aRes.data['result: '] === 'enabled(kyc_0)';
            const existing = this.attestations.find(a => a.address === address);
            existing
                ? existing.isAttested = isAttested
                : this.attestations.push({ address, isAttested });
            return isAttested;
        } catch (error: any) {
            this.toastrService.error(error.messagokee, `Checking Attestations Error, Adress: ${address}`);
            return false;
        }
    }

    private removeAll() {
        this.attestations = [];
    }
    
    private async checkPending() {
        const pendingList = this.attestations.filter(a => a.isAttested === 'PENDING');
        for (let i = 0; i < pendingList.length; i++) {
            const address = pendingList[i].address;
            const isAttested = await this.checkAttAddress(address);
            const existing = this.attestations.find(a => a.address === address);
            existing
                ? existing.isAttested = isAttested
                : this.attestations.push({ address, isAttested });
        }
    }
    
    getAttByAddress(address: string) {
        return this.attestations
            .find(e => e.address === address)?.isAttested || false;
    }

    setPendingAtt(address: string) {
        const existing = this.attestations.find(a => a.address === address);
        if (existing) existing.isAttested = 'PENDING';
    }
}