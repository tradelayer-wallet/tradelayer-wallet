import { Component, OnInit } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { ToastrService } from 'ngx-toastr';
import { AuthService, EAddress } from 'src/app/@core/services/auth.service';
import { IRewardKeyPair, NodeRewardService } from 'src/app/@core/services/node-reward.service';
import { PasswordDialog } from 'src/app/@shared/dialogs/password/password.component';
import { first } from 'rxjs/operators';
import { BalanceService } from 'src/app/@core/services/balance.service';

@Component({
    templateUrl: './node-reward-page.component.html',
    styleUrls: ['./node-reward-page.component.scss']
  })

  export class NodeRewardPageComponent implements OnInit {
    rewardTableColumns: string[] = ['address', 'balance', 'action'];
  
    constructor(
      private toastrService: ToastrService,
      private nodeRewardService: NodeRewardService,
      private authService: AuthService,
      public matDialog: MatDialog,
      private balanceService: BalanceService,
    ) {}

    get rewardAddresses() {
      return this.nodeRewardService.rewardAddresses;
    }

    get maxRewardAddresses() {
      return 3;
    }
  
    ngOnInit(){}

    async generateRewardAddress() {
      try {
        if (this.authService.walletKeys.reward.length > this.maxRewardAddresses) {
          this.toastrService.error('The Limit of Futures Addresses is Reached');
          return;
        }
        const passDialog = this.matDialog.open(PasswordDialog);
        const password = await passDialog.afterClosed()
            .pipe(first())
            .toPromise();
        if (!password) return;
  
        await this.authService.addKeyPair(EAddress.REWARD, password);
        this.nodeRewardService.rewardAddresses = [...this.authService.walletKeys.reward];
        this.nodeRewardService.checkRegisteredAddresses();
      } catch(error: any) {
        // error
      }
    }

    copy(text: string) {
      navigator.clipboard.writeText(text);
      this.toastrService.info('Address Copied to clipboard', 'Copied')
    }

    toggleAutoClaim(keyPair: IRewardKeyPair) {
      const balanceObj = this.balanceService.getCoinBalancesByAddress(keyPair.address);
      if (balanceObj.confirmed < 0.001) {
        this.toastrService.error('You need at least 0.001 LTC', 'Error');
        return;
      }
      keyPair.autoClaim = !keyPair.autoClaim;
    }

    async register(keyPair: IRewardKeyPair) {
      const balanceObj = this.balanceService.getCoinBalancesByAddress(keyPair.address);
      if (balanceObj.confirmed < 0.002) {
        this.toastrService.error('You need at least 0.002 LTC', 'Error');
        return;
      }
      await this.nodeRewardService.registerAddress(keyPair);
    }

    getAddressBalance(address: string) {
      const balanceObj = this.balanceService.getCoinBalancesByAddress(address);
      return `${balanceObj.confirmed}/${balanceObj.unconfirmed}`;
    }
  }
