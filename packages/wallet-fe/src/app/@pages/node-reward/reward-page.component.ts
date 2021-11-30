import { Component } from '@angular/core';
import { ToastrService } from 'ngx-toastr';
import { RewardService } from 'src/app/@core/services/reward.service';

@Component({
  selector: 'tl-reward-page',
  templateUrl: './reward-page.component.html',
  styleUrls: ['./reward-page.component.scss']
})
export class NodeRewardPageComponent {
    rewardTableColumns: string[] = ['address', 'balance', 'status', 'history'];

    constructor(
      private toastrService: ToastrService,
      private rewardService: RewardService,
    ) {}

    get maxRewardAddresses() {
      return this.rewardService.maxNRewardAddresses;
    }

    get rewardAddresses() {
      return this.rewardService.rewardAddresses;
    }
  
    addNewRewardAddress() {
      if (this.rewardAddresses.length >= this.maxRewardAddresses) {
        this.toastrService.warning(`Max Reward Addresses: ${this.maxRewardAddresses}`, 'Warning');
        return;
      }
      this.rewardService.addNewRewardAddress();
    }
  
    copy(text: string) {
      navigator.clipboard.writeText(text);
      this.toastrService.info('Address Copied to clipboard', 'Copied')
    }
}
