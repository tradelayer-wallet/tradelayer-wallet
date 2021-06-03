import { Component, OnInit } from '@angular/core';
import { FormBuilder, FormGroup, Validators } from '@angular/forms';
import { AddressService } from 'src/app/@core/services/address.service';
import { AuthService } from 'src/app/@core/services/auth.service';
import { BalanceService } from 'src/app/@core/services/balance.service';
import { IMarket, MarketsService } from 'src/app/@core/services/markets.service';
import { TradeService, ITradeConf } from 'src/app/@core/services/trade.service';

@Component({
  selector: 'tl-buy-sell-card',
  templateUrl: './buy-sell-card.component.html',
  styleUrls: ['./buy-sell-card.component.scss']
})
export class BuySellCardComponent implements OnInit {
    buySellGroup: FormGroup = new FormGroup({});

    constructor(
      private marketService: MarketsService,
      private balanceService: BalanceService,
      private fb: FormBuilder,
      private authService: AuthService,
      private addressService: AddressService,
      private tradeService: TradeService,
    ) {}

    get isLoggedIn() {
      return this.authService.isLoggedIn;
    }

    get selectedMarket(): IMarket {
      return this.marketService.selectedMarket;
    }

    get currentAddress() {
      return this.addressService.activeKeyPair?.address;
    }

    ngOnInit() {
      this.buildForms()
    }

    private buildForms() {
      this.buySellGroup = this.fb.group({
        price: [null, [Validators.required, Validators.min(0)]],
        amount: [null, [Validators.required, Validators.min(0.1)]],
      })
    }

    getMaxAmount(isBuy: boolean) {
      if (this.buySellGroup.controls['price']?.value === 0 || !this.currentAddress) return '-';
      if (isBuy) {
        const propIdForSale = this.selectedMarket.second_token.propertyId;
        if (propIdForSale === 999) {
            const price = this.buySellGroup.value['price']
            const balance = this.balanceService.addressesBalance[this.currentAddress].confirmed_balance;
            return (balance / price).toFixed(4);
        }
      }
      return '0';
    }

    handleBuy() {
      const { price, amount } = this.buySellGroup.value;
      const market = this.selectedMarket;
      const propIdForSale = market.second_token.propertyId;
      const propIdDesired = market.first_token.propertyId;
      const amountForSale = parseFloat((amount * price).toFixed(4));
      const amountDeisred = parseFloat((amount).toFixed(4));
      if (!propIdForSale || !propIdDesired || !amountForSale || !amountDeisred) return;
      const tradeConf: ITradeConf = { propIdForSale, propIdDesired, amountForSale, amountDeisred };
      this.tradeService.initTrade(tradeConf);
    }

    handleSell() {
      console.log('Sell')
    }

    getButtonDisabled(isBuy: boolean) {
      if (isBuy) {
        const v = this.buySellGroup.value.amount < parseFloat(this.getMaxAmount(true));
        return !this.buySellGroup.valid || !v;
      }
      return true;
    }
}
