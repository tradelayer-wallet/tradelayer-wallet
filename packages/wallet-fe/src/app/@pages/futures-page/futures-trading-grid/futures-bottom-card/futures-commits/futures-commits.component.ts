import { Component, OnInit, OnDestroy } from '@angular/core';
import { AuthService } from 'src/app/@core/services/auth.service';
import { RpcService } from 'src/app/@core/services/rpc.service';
import { Subscription } from 'rxjs';
import { IBuildTxConfig, TxsService } from 'src/app/@core/services/txs.service';
import { LoadingService } from 'src/app/@core/services/loading.service';
import { ToastrService } from 'ngx-toastr';
import { FuturesChannelsService, IChannelCommit } from 'src/app/@core/services/futures-services/futures-channels.service';

@Component({
  selector: 'tl-futures-commits',
  templateUrl: './futures-commits.component.html',
  styleUrls: ['./futures-commits.component.scss']
})

export class FuturesChannelsComponent implements OnInit, OnDestroy {
    private subsArray: Subscription[] = [];
    displayedColumns: string[] = ['property', 'sender', 'channel', 'amount', 'block', 'actions'];

    constructor(
      private futuresChannelsService: FuturesChannelsService,
      private rpcService: RpcService,
      private authService: AuthService,
      private txsService: TxsService,
      private loadingService: LoadingService,
      private toastrService: ToastrService,
    ) {}

    get activeChannelsCommits() {
      return this.futuresChannelsService.channelsCommits;
    }

    async closeCommit(commit: IChannelCommit) {
      this.loadingService.isLoading = true;
      try {
        const payloadConfig = [commit.propertyId, (commit.amount).toString()];
        const payloadRes = await this.rpcService.rpc('tl_createpayload_withdrawal_fromchannel', payloadConfig);
        if (payloadRes.error || !payloadRes.data) throw new Error(payloadRes.error);
        const config: IBuildTxConfig = {
          fromKeyPair: {
            address: commit.sender,
          },
          toKeyPair: {
            address: commit.channel
          },
          payload: payloadRes.data,
        };
        const res = await this.txsService.buildSingSendTx(config);
        if (res.error || !res.data) throw new Error(res.error);
        this.toastrService.success(`Withdraw TX: ${res.data}`, 'Success');
      } catch (err: any) {
        this.toastrService.error(err.message, 'Error');
      } finally {
        this.loadingService.isLoading = false;
      }
    }

    ngOnInit() {
      this.subscribes();
    }

    subscribes() {
      const blockSubs = this.rpcService.blockSubs$
        .subscribe(() => this.futuresChannelsService.updateOpenChannels());

      const updateSubs$ = this.authService.updateAddressesSubs$
        .subscribe(kp =>{
          if (!this.authService.activeSpotKey || !kp.length) this.futuresChannelsService.removeAll();
          this.futuresChannelsService.updateOpenChannels();
        });
      this.subsArray = [blockSubs, updateSubs$];
    }

    ngOnDestroy(): void {
      this.subsArray.forEach(s => s.unsubscribe()) ;
    }

    copy(text: string) {
      navigator.clipboard.writeText(text);
      this.toastrService.info(`Transaction Id Copied to clipboard: ${text}`, 'Copied')
    }
}
