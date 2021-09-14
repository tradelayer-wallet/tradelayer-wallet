import { Component, OnInit } from '@angular/core';
import { AddressService } from 'src/app/@core/services/address.service';
import { BalanceService } from 'src/app/@core/services/balance.service';
import { DialogService, DialogTypes } from 'src/app/@core/services/dialogs.service';

@Component({
  selector: 'tl-portoflio-page',
  templateUrl: './portfolio-page.component.html',
  styleUrls: ['./portfolio-page.component.scss']
})
export class PortfolioPageComponent implements OnInit{
  cryptoBalanceColumns: string[] = ['address', 'total', 'available', 'locked', 'actions'];
  tokensBalanceColums: string[] = ['propertyid', 'name', 'available', 'locked'];
  
  constructor(
    private balanceService: BalanceService,
    private addressService: AddressService,
    private dialogService: DialogService,
  ) {}

  get balances() {
    const balances = this.balanceService.allBalances;
    return Object.keys(balances).map((bal) => ({...balances[bal], address: bal}));
  }

  get tokensBalances() {
    const balances = this.balanceService.getBalancesByAddress();
    return Object.values(balances).filter(k => k.type === 'TOKEN');;
  }

  get selectedAddress() {
    return this.addressService.activeKeyPair?.address;
  }

  ngOnInit() {}

  openDialog(dialog: string, data: any) {
    if (dialog === 'deposit') {
      this.dialogService.openDialog(DialogTypes.DEPOSIT, { disableClose: false, data });
    }

    if (dialog === 'withdraw') {
      this.dialogService.openDialog(DialogTypes.WITHDRAW, { disableClose: false, data });
    }
  }
}