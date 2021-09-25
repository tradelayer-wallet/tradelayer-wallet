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
  cryptoBalanceColumns: string[] = ['address', 'available', 'locked', 'total', 'actions'];
  tokensBalanceColums: string[] = ['propertyid', 'name', 'available', 'locked', 'reserved', 'actions'];
  
  constructor(
    private balanceService: BalanceService,
    private addressService: AddressService,
    private dialogService: DialogService,
  ) {}

  get fiatBalance() {
    return Object.keys(this.allBalances)
      .map(address => ({ address, ...(this.allBalances?.[address]?.fiatBalance || {}) }));
  }

  get tokensBalances() {
    return this.balanceService.getTokensBalancesByAddress();
  }

  get selectedAddress() {
    return this.addressService.activeKeyPair?.address;
  }

  get allBalances() {
    return this.balanceService.allBalances;
  }
 
  ngOnInit() {}

  getAvailableFiatBalance(element: any) {
    const confirmed = element?.confirmed || 0;
    const locked = element?.locked || 0;
    const available = confirmed - locked;
    return available.toFixed(5);
  }

  getLockedFiatBalance(element: any) {
    const locked = element?.locked || 0;
    return locked.toFixed(5);
  }

  getTotalFiatBalnace(element: any) {
    const confirmed = element?.confirmed || 0;
    const unconfirmed = element?.unconfirmed || 0;

    return `${confirmed.toFixed(3)}/${unconfirmed.toFixed(3)}`
  }

  getAvailableTokensBalance(element: any) {
    const balance = element?.balance || 0;
    const locked = element?.locked || 0;
    const available = balance - locked;
    return available.toFixed(5);
  }

  getLockedTokensBalance(element: any) {
    const locked = element?.locked || 0;
    return locked.toFixed(5);
  }

  getReservedTokensBalance(element: any) {
    const locked = element?.reserved || 0;
    return locked.toFixed(5);
  }

  openDialog(dialog: string, _address?: any, _propId?: number) {
    if (dialog === 'deposit') {
      const data = { address: _address || this.selectedAddress };
      this.dialogService.openDialog(DialogTypes.DEPOSIT, { disableClose: false, data });
    }

    if (dialog === 'withdraw') {
      const data = { address: _address || this.selectedAddress, propId: _propId };
      this.dialogService.openDialog(DialogTypes.WITHDRAW, { disableClose: false, data });
    }
  }
}