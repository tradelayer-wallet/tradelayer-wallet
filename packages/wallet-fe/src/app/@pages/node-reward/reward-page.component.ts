import { Component, OnInit } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { ToastrService } from 'ngx-toastr';
import { first } from 'rxjs/operators';
import { AddressService, IKeyPair } from 'src/app/@core/services/address.service';
import { ApiService } from 'src/app/@core/services/api.service';
import { AuthService } from 'src/app/@core/services/auth.service';
import { DialogService } from 'src/app/@core/services/dialogs.service';
import { LoadingService } from 'src/app/@core/services/loading.service';
import { RewardService } from 'src/app/@core/services/reward.service';
import { RpcService } from 'src/app/@core/services/rpc.service';
import { PasswordDialog } from 'src/app/@shared/dialogs/password/password.component';
import { decryptKeyPair, encryptKeyPair } from 'src/app/utils/litecore.util';

@Component({
  selector: 'tl-reward-page',
  templateUrl: './reward-page.component.html',
  styleUrls: ['./reward-page.component.scss']
})
export class NodeRewardPageComponent implements OnInit {
    rewardTableColumns: string[] = ['address', 'balance', 'status'];
    rawBalanceObj: any = {};

    constructor(
      private toastrService: ToastrService,
      private rewardService: RewardService,
      private rpcService: RpcService,
      private apiService: ApiService,
      private addressService: AddressService,
      private matDialog: MatDialog,
      private authService: AuthService,
      private dialogService: DialogService,
      private loadingService: LoadingService,
    ) {}

    get maxRewardAddresses() {
      return this.addressService.maxNRewardAddresses;
    }

    get rewardAddresses() {
      return this.rewardService.rewardAddresses;
    }
  
    get autoClaimAddresses() {
      return this.rewardService.autoClaimAddresses;
    }
  
    get soChainApi() {
      return this.apiService.soChainApi;
    }
  
    get ssApi() {
      return this.apiService.socketScriptApi;
    }
  
    get waitingList() {
      return this.rewardService.waitingList;
    }
  
    get registeredList() {
      return this.rewardService.registeredList;
    }
  
    ngOnInit() {
      if (!this.rpcService.isOffline) this.rewardAddresses.forEach(e => this.getBalanceForAddress(e));
    }

    isAddressAutoClaiming(address: string) {
      return this.autoClaimAddresses.includes(address)
    }

    isAddressRegistered(address: string) {
      return this.registeredList.includes(address);
    }

    isAddressWaiting(address: string) {
      return this.waitingList.includes(address);
    }
  
    async getBalanceForAddress(pair: IKeyPair) {
      this.rawBalanceObj[pair.address] = '-';
      if (this.rpcService.isOffline)  {
        this.toastrService.warning('Cant get multisig balance in Offline mode');
        return;
      }
      const res: any = await this.soChainApi.getTxUnspents(pair.address).toPromise();
  
      if (res.status !== 'success' || !res.data?.txs) {
        this.rawBalanceObj[pair.address] = '-';
      } else {
        const sum = res.data.txs.reduce((a: any, b: any) => parseFloat(b.value) + a, 0);
        this.rawBalanceObj[pair.address] = sum || sum === 0 ? sum.toFixed(6) : '-';
      }
    }

    async generateRewardAddresses() {
      if (this.rewardAddresses.length >= this.maxRewardAddresses) {
        this.toastrService.warning(`Max Reward Addresses: ${this.maxRewardAddresses}`, 'Warning');
        return;
      }

      const passDialog = this.matDialog.open(PasswordDialog);
      const password = await passDialog.afterClosed()
          .pipe(first())
          .toPromise();
      if (!password) return;
      const encKey = this.authService.encKey;
      const decryptResult = decryptKeyPair(encKey, password);
      if (!decryptResult) {
          this.toastrService.error('Wrong Password', 'Error');
      } else {
        await this.addressService.generateRewardAddresses();
        const allKeyParis = [
            ...this.addressService.keyPairs, 
            ...this.addressService.multisigPairs, 
            ...this.addressService.rewardAddresses,
        ];
        this.authService.encKey = encryptKeyPair(allKeyParis, password);
        this.dialogService.openEncKeyDialog(this.authService.encKey);
      }

    }
  
    copy(text: string) {
      navigator.clipboard.writeText(text);
      this.toastrService.info('Address Copied to clipboard', 'Copied')
    }

    async fund(toAddress: string) {
      if (!this.addressService.activeKeyPair?.address ) return;
      this.loadingService.isLoading = true;
      const fromAddress = this.addressService.activeKeyPair.address;
      const res = await this.ssApi.withdraw(fromAddress, toAddress, 0.005).toPromise();
      res.error || !res.data
        ?  this.toastrService.error(res.error || 'Undefined Error', 'Error')
        : this.toastrService.success(`${toAddress} was successfully funded`, 'Successful Fund');
      this.loadingService.isLoading = false;
    }

    register(address: string) {
      if (this.rawBalanceObj[address] === (0).toFixed(6) || this.rawBalanceObj[address] === '-') {
        this.toastrService.error(`Please first fund the address`, 'Empty Address');
        return;
      }
      this.rewardService.register(address);
    }

    autoClaim(address: string) {
      this.rewardService.setAutoClaim(address);
    }

    // async openHistort() {
    //   this.toastrService.warning('Not available', 'This Feature will be available soon');
    // }
}
