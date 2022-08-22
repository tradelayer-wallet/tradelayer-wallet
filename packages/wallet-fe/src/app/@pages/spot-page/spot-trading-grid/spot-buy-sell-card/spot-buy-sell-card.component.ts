import { Component, OnDestroy, OnInit } from '@angular/core';
import { FormBuilder, FormGroup, Validators } from '@angular/forms';
import { ReplaySubject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { AuthService } from 'src/app/@core/services/auth.service';
import { BalanceService } from 'src/app/@core/services/balance.service';
import { IMarket, SpotMarketsService } from 'src/app/@core/services/spot-services/spot-markets.service';
import { SpotOrderbookService } from 'src/app/@core/services/spot-services/spot-orderbook.service';
import { ISpotTradeConf, TradeService } from 'src/app/@core/services/trade.service';
import { safeNumber } from 'src/app/utils/common.util';
// import { SpotOrderbookService } from 'src/app/@core/services/spot-services/spot-orderbook.service';
// import { TradeService, ISpotTradeConf } from 'src/app/@core/services/trade.service';

@Component({
  selector: 'tl-spot-buy-sell-card',
  templateUrl: './shared-buy-sell-card.component.html',
  styleUrls: ['./shared-buy-sell-card.component.scss'],
})
export class SpotBuySellCardComponent implements OnInit, OnDestroy {
    private destroyed$: ReplaySubject<boolean> = new ReplaySubject(1);
    buySellGroup: FormGroup = new FormGroup({});
    private _isLimitSelected: boolean = true;

    constructor(
      private spotMarketsService: SpotMarketsService,
      private balanceService: BalanceService,
      private fb: FormBuilder,
      private tradeService: TradeService,
      private spotOrderbookService: SpotOrderbookService,
      private authService: AuthService,
    ) {}

    get isLoading(): boolean {
      return false;
    }

    get selectedMarket(): IMarket {
      return this.spotMarketsService.selectedMarket;
    }

    get currentAddress() {
      return this.activeKeyPair?.address;
    }

    get activeKeyPair() {
      return this.authService.activeMainKey
    }

    get currentPrice() {
      return this.spotOrderbookService.currentPrice;
    }

    get isLimitSelected() {
      return this._isLimitSelected;
    }

    set isLimitSelected(value: boolean) {
      this._isLimitSelected = value;
      this.buySellGroup.controls.price.setValue(this.currentPrice);
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
      const value = this.getMaxAmount(isBuy);
      this.buySellGroup?.controls?.['amount'].setValue(value);
    }

    getTotal(isBuy: boolean): string {
      const { price, amount } = this.buySellGroup.value;
      const tokenName = isBuy 
        ? this.selectedMarket.second_token.shortName
        : this.selectedMarket.first_token.shortName;
      const _amount = isBuy
        ? (price * amount).toFixed(4)
        : (amount || 0).toFixed(4);
      return `${_amount} ${tokenName}`;
    }

    getMaxAmount(isBuy: boolean) {
      if (!this.currentAddress) return 0;
      if (!this.buySellGroup?.controls?.['price']?.value && this.isLimitSelected) return 0;
      const _price = this.isLimitSelected 
        ? this.buySellGroup.value['price'] 
        : this.currentPrice;
      const price = safeNumber(_price);

      const propId = isBuy
        ? this.selectedMarket.second_token.propertyId
        : this.selectedMarket.first_token.propertyId;

      const _available = propId === -1
        ? this.balanceService.getCoinBalancesByAddress(this.currentAddress)?.confirmed
        : this.balanceService.getTokensBalancesByAddress(this.currentAddress)
          ?.find((t: any) => t.propertyid === propId)
          ?.balance;
      const available = safeNumber(_available || 0);
      if (!available || ((available / price) <= 0)) return 0;
      const _max = isBuy ? (available / price) : available;
      const max = safeNumber(_max);
      return max;
    }


    handleBuySell(isBuy: boolean) {
      const amount = this.buySellGroup.value.amount;
      const _price = this.buySellGroup.value.price;
      const price = this.isLimitSelected ? _price : this.currentPrice;

      const market = this.selectedMarket;
      const propIdForSale = isBuy ? market.second_token.propertyId : market.first_token.propertyId;
      const propIdDesired = isBuy ? market.first_token.propertyId : market.second_token.propertyId;
      if (!propIdForSale || !propIdDesired || (!price && this.isLimitSelected) || !amount) return;
      if (!this.activeKeyPair) return;
  
      const order: ISpotTradeConf = { 
        keypair: {
          address: this.activeKeyPair?.address,
          pubkey: this.activeKeyPair?.pubkey,
        },
        action: isBuy ? "BUY" : "SELL",
        type: "SPOT",
        props: {
          id_desired: propIdDesired,
          id_for_sale: propIdForSale,
          amount: amount,
          price: price,
        },
        isLimitOrder: this.isLimitSelected,
      };
      this.tradeService.newOrder(order);
      this.buySellGroup.reset();
    }

    getButtonDisabled(isBuy: boolean) {
      const v = this.buySellGroup.value.amount <= this.getMaxAmount(isBuy);
      return !this.buySellGroup.valid || !v;
    }

    private trackPriceHandler() {
      this.spotOrderbookService.outsidePriceHandler
        .pipe(takeUntil(this.destroyed$))
        .subscribe(price => {
          this.buySellGroup.controls['price'].setValue(price);
        });
    }

    ngOnDestroy() {
      this.destroyed$.next(true);
      this.destroyed$.complete();
    }
}
