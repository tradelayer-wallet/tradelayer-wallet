import { Component, OnDestroy, OnInit } from '@angular/core';
import { FormBuilder, FormGroup, Validators } from '@angular/forms';
import { ReplaySubject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { AddressService } from 'src/app/@core/services/address.service';
import { AuthService } from 'src/app/@core/services/auth.service';
import { BalanceService } from 'src/app/@core/services/balance.service';
import { IMarket, MarketsService } from 'src/app/@core/services/markets.service';
import { OrderbookService } from 'src/app/@core/services/orderbook.service';
import { TradeService, ITradeConf } from 'src/app/@core/services/trade.service';

@Component({
  selector: 'tl-buy-sell-card',
  templateUrl: './buy-sell-card.component.html',
  styleUrls: ['./buy-sell-card.component.scss']
})
export class BuySellCardComponent implements OnInit, OnDestroy {
    private destroyed$: ReplaySubject<boolean> = new ReplaySubject(1);
    buySellGroup: FormGroup = new FormGroup({});

    constructor(
      private marketService: MarketsService,
      private balanceService: BalanceService,
      private fb: FormBuilder,
      private authService: AuthService,
      private addressService: AddressService,
      private tradeService: TradeService,
      private orderbookService: OrderbookService,
    ) {}

    get selectedMarket(): IMarket {
      return this.marketService.selectedMarket;
    }

    get currentAddress() {
      return this.addressService.activeKeyPair?.address;
    }

    ngOnInit() {
      this.buildForms();
      this.trackPriceHandler();
    }

    private buildForms() {
      this.buySellGroup = this.fb.group({
        price: [null, [Validators.required, Validators.min(0.01)]],
        amount: [null, [Validators.required, Validators.min(0.01)]],
      })
    }

    fillMax(isBuy: boolean) {
      const value = parseFloat(this.getMaxAmount(isBuy));
      this.buySellGroup?.controls?.['amount'].setValue(value);
    }

    getTotal(isBuy: boolean): string {
      const { price, amount } = this.buySellGroup.value;
      const tokenName = isBuy 
        ? this.selectedMarket.first_token.shortName
        : this.selectedMarket.second_token.shortName;
      return `${(price * amount).toFixed(4)} ${tokenName}`;
    }

    getMaxAmount(isBuy: boolean) {
      if (!this.currentAddress) return '0';
      if (!this.buySellGroup?.controls?.['price']?.value) return '0';
      const fee = 0.1;
      const _price = this.buySellGroup.value['price'];
      const price = parseFloat((_price + fee));

      const propId = isBuy
        ? this.selectedMarket.first_token.propertyId
        : this.selectedMarket.second_token.propertyId;

      const balance = this.balanceService.getAddressBalanceForId(propId)?.available;
      if (!balance || ((balance / price) <= 0)) return '0';
      return (balance / price).toFixed(4);
    }


    handleBuySell(isBuy: boolean) {
      const { price, amount } = this.buySellGroup.value;
      const market = this.selectedMarket;
      const propIdForSale = isBuy ? market.second_token.propertyId : market.first_token.propertyId;
      const propIdDesired = isBuy ? market.first_token.propertyId : market.second_token.propertyId;
      const marketName = market.pairString;
      if (!propIdForSale || !propIdDesired || !price || !amount) return;
      const newTrade: ITradeConf = { price, amount, propIdForSale, propIdDesired, isBuy, marketName };
      this.tradeService.initNewTrade(newTrade);
      this.buySellGroup.reset();
    }

    getButtonDisabled(isBuy: boolean) {
      const v = this.buySellGroup.value.amount <= this.getMaxAmount(isBuy);
      return !this.buySellGroup.valid || !v;
    }

    private trackPriceHandler() {
      this.orderbookService.outsidePriceHandler
      .pipe(takeUntil(this.destroyed$))
      .subscribe(price => {
        this.buySellGroup.controls['price'].setValue(price);
      })
    }

    ngOnDestroy() {
      this.destroyed$.next(true);
      this.destroyed$.complete();
    }
}
