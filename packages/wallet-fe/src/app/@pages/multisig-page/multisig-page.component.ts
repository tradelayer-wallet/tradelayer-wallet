import { Component } from '@angular/core';
import { ToastrService } from 'ngx-toastr';
import { AddressService } from 'src/app/@core/services/address.service';
import { DialogService, DialogTypes } from 'src/app/@core/services/dialogs.service';

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
  ) {}

  get multisigs() {
    return this.addressService.multisigPairs;
  }

  newMultisig() {
    this.customDialogs.openDialog(DialogTypes.NEW_MULTISIG, { disableClose: false });
  }

  newTx() {
        this.customDialogs.openDialog(DialogTypes.TX_BUILDER, { disableClose: false });
  }

  copy(text: string) {
    navigator.clipboard.writeText(text);
    this.toastrService.info('Address Copied to clipboard', 'Copied')
  }
}
