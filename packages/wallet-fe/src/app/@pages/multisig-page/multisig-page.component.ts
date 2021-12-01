import { Component } from '@angular/core';
import { ToastrService } from 'ngx-toastr';
import { AddressService } from 'src/app/@core/services/address.service';
import { AuthService } from 'src/app/@core/services/auth.service';
import { DialogService, DialogTypes } from 'src/app/@core/services/dialogs.service';
import { WindowsService } from 'src/app/@core/services/windows.service';

@Component({
  selector: 'tl-multisig-page',
  templateUrl: './multisig-page.component.html',
  styleUrls: ['./multisig-page.component.scss']
})
export class MultisigPageComponent {
  multisigTableColumns: string[] = ['address', 'nkeys', 'pvalue', 'keys'];

  constructor(
    private toastrService: ToastrService,
    private customDialogs: DialogService,
    private addressService: AddressService,
    private authService: AuthService,
    private windowsService: WindowsService,
  ) {}

  get multisigs() {
    return this.addressService.multisigPairs;
  }

  get isLoggedIn() {
    return this.authService.isLoggedIn;;
  }

  newMultisig() {
    this.customDialogs.openDialog(DialogTypes.NEW_MULTISIG, { disableClose: false });
  }

  newTx(event: Event) {
    event.stopImmediatePropagation();
    this.windowsService.addTxBuilder();
  }

  copy(text: string) {
    navigator.clipboard.writeText(text);
    this.toastrService.info('Address Copied to clipboard', 'Copied')
  }
}
