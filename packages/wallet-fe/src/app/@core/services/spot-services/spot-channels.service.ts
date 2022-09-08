import { Injectable } from "@angular/core";
import { ToastrService } from "ngx-toastr";
import { AuthService } from "../auth.service";
import { BalanceService } from "../balance.service";
import { RpcService } from "../rpc.service";

export interface IChannelCommit {
    amount: number;
    block: number;
    channel: string;
    propertyId: number;
    sender: string;
    tokenName: string;
}

@Injectable({
    providedIn: 'root',
})

export class SpotChannelsService {
    private _channelsCommits: IChannelCommit[] = [];

    constructor(
        private rpcService: RpcService,
        private authService: AuthService,
        private toastrService: ToastrService,
        private balanceService: BalanceService,
    ) { }

    get channelsCommits() {
        return this._channelsCommits;
    }

    get activeSpotaddress() {
        return this.authService.activeSpotKey?.address || null;
    }

    async updateOpenChannels() {
        try {
            if (!this.activeSpotaddress) {
                this._channelsCommits = [];
                return;
            }
            const commitsRes = await this.rpcService.rpc('tl_check_commits', [this.activeSpotaddress]);
            if (commitsRes.error || !commitsRes.data) throw new Error(`tl_check_commits: ${commitsRes.error}`);
            const promiseArray = commitsRes.data.map(async (q: any) => {
                return {
                    amount: parseFloat(q.amount),
                    propertyId: parseFloat(q.propertyId),
                    block: q.block,
                    channel: q.channel,
                    sender: q.sender,
                    tokenName: await this.balanceService.getTokenNameById(parseFloat(q.propertyId)),
                };
            });
            this._channelsCommits = await Promise.all(promiseArray);
        } catch (err: any) {
            this.toastrService.warning(err.message);
        }
    }

    removeAll() {
        this._channelsCommits = [];
    }
}