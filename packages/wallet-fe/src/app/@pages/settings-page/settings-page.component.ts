import { Component } from '@angular/core';
import { ToastrService } from 'ngx-toastr';
import { AddressService, EKYCStatus } from 'src/app/@core/services/address.service';
import { BalanceService } from 'src/app/@core/services/balance.service';
import { RpcService } from 'src/app/@core/services/rpc.service';

@Component({
  selector: 'tl-settings-page',
  templateUrl: './settings-page.component.html',
  styleUrls: ['./settings-page.component.scss']
})
export class SettingsPageComponent {
    constructor(
      private addressesService: AddressService,
      private balanceSerivce: BalanceService,
      private toasterService: ToastrService,
    ) {}

    get address() {
      return this.addressesService.activeKeyPair?.address;
    }

    get liquitiyAddress() {
      return this.addressesService.liquidityAddresses?.[0]?.address;
    }
  
    get status() {
      return this.addressesService.activeAddressKYCStatus;
    }

    get liquidityStatus() {
      return this.addressesService.liquidityAddressesKYCStatus;
    }

    get buttonDisabled() {
      return this.status !== EKYCStatus.DISABLED || !this.address;
    }

    get liquidityButtonDisabled() {
      return this.liquidityStatus !== EKYCStatus.DISABLED || !this.liquitiyAddress;
    }
  
    kyc(address: string) {
      const balance = this.balanceSerivce.getFiatBalancesByAddress(address);
      // const { confirmed, locked } = balance;
      const available = parseFloat((balance.confirmed).toFixed(6));
      if (available < 0.0002) {
        this.toasterService.error('You need at least 0.0002 ltc for Self-Attestation,');
        return;
      }
      this.addressesService.kycAddress(address);
    }
}
