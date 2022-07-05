import { Component } from '@angular/core';
import { ToastrService } from 'ngx-toastr';
import { AuthService } from 'src/app/@core/services/auth.service';
// import { AddressService, EKYCStatus } from 'src/app/@core/services/address.service';
import { BalanceService } from 'src/app/@core/services/balance.service';
import { RpcService } from 'src/app/@core/services/rpc.service';

@Component({
  selector: 'tl-settings-page',
  templateUrl: './settings-page.component.html',
  styleUrls: ['./settings-page.component.scss']
})
export class SettingsPageComponent {
    constructor(
      // private addressesService: AddressService,
      private balanceSerivce: BalanceService,
      private toasterService: ToastrService,
      private authService: AuthService,
    ) {}

    get allAddresses() {
      return this.authService.listOfallAddresses
        .map(kp => kp.address);
    }

    kyc(address: string) {
      return;
    }
}
