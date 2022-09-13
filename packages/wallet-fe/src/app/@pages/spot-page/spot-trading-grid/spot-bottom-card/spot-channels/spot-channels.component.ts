import { Component, OnInit, OnDestroy } from '@angular/core';
import { AuthService } from 'src/app/@core/services/auth.service';
import { RpcService } from 'src/app/@core/services/rpc.service';
import { IChannelCommit, SpotChannelsService } from 'src/app/@core/services/spot-services/spot-channels.service';
import { Subscription } from 'rxjs';
import { IBuildTxConfig, TxsService } from 'src/app/@core/services/txs.service';
import { LoadingService } from 'src/app/@core/services/loading.service';
import { ToastrService } from 'ngx-toastr';

@Component({
  selector: 'tl-spot-channels',
  templateUrl: './spot-channels.component.html',
  styleUrls: ['./spot-channels.component.scss']
})

export class SpotChannelsComponent implements OnInit, OnDestroy {
    private subsArray: Subscription[] = [];
    displayedColumns: string[] = ['property', 'sender', 'channel', 'amount', 'block', 'actions'];

    constructor(
      private spotChannelsService: SpotChannelsService,
      private rpcService: RpcService,
      private authService: AuthService,
      private txsService: TxsService,
      private loadingService: LoadingService,
      private toastrService: ToastrService,
    ) {}

    get activeChannelsCommits() {
      return this.spotChannelsService.channelsCommits;
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
        .subscribe(() => this.spotChannelsService.updateOpenChannels());

      const updateSubs$ = this.authService.updateAddressesSubs$
        .subscribe(kp =>{
          if (!this.authService.activeSpotKey || !kp.length) this.spotChannelsService.removeAll();
          this.spotChannelsService.updateOpenChannels();
        });
      this.subsArray = [blockSubs, updateSubs$];
    }

    ngOnDestroy(): void {
      this.subsArray.forEach(s => s.unsubscribe()) ;
    }
}
