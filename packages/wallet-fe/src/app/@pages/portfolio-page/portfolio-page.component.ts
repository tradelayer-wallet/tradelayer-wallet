import { Component, OnInit } from '@angular/core';
import { AddressService } from 'src/app/@core/services/address.service';
import { BalanceService } from 'src/app/@core/services/balance.service';

@Component({
  selector: 'tl-portoflio-page',
  templateUrl: './portfolio-page.component.html',
  styleUrls: ['./portfolio-page.component.scss']
})
export class PortfolioPageComponent implements OnInit{
  cryptoBalanceColumns: string[] = ['address', 'total', 'confirmed', 'unconfirmed'];
  tokensBalanceColums: string[] = ['propertyid', 'name', 'balance', 'reserve'];
  
  constructor(
    private balanceService: BalanceService,
    private addressService: AddressService,
  ) {}

  get cryptoBalance() {
    return this.balanceService.structuredLTCBalances;
  }

  get tokensBalances() {
    return this.balanceService.addressesTokensBalanceForAddress;
  }

  get selectedAddress() {
    return this.addressService.activeKeyPair?.address;
  }

  ngOnInit() {}
}
