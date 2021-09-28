import { Component, OnDestroy, OnInit } from '@angular/core';
import { FormBuilder, FormGroup, Validators } from '@angular/forms';
import { ReplaySubject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { AddressService } from 'src/app/@core/services/address.service';
import { BalanceService } from 'src/app/@core/services/balance.service';
import { LoadingService } from 'src/app/@core/services/loading.service';
import { IMarket, SpotMarketsService } from 'src/app/@core/services/spot-services/spot-markets.service';
import { SpotOrderbookService } from 'src/app/@core/services/spot-services/spot-orderbook.service';
import { TradeService, ITradeConf } from 'src/app/@core/services/spot-services/trade.service';

@Component({
  selector: 'tl-spot-buy-sell-card',
  templateUrl: './spot-buy-sell-card.component.html',
  styleUrls: ['./spot-buy-sell-card.component.scss']
})
export class SpotBuySellCardComponent implements OnInit, OnDestroy {
    private destroyed$: ReplaySubject<boolean> = new ReplaySubject(1);
    buySellGroup: FormGroup = new FormGroup({});

    constructor(
      private spotMarketsService: SpotMarketsService,
      private balanceService: BalanceService,
      private fb: FormBuilder,
      private addressService: AddressService,
      private tradeService: TradeService,
      private spotOrderbookService: SpotOrderbookService,
      private loadingService: LoadingService,
    ) {}

    get isLoading(): boolean {
      return this.loadingService.tradesLoading;
    }

    get selectedMarket(): IMarket {
      return this.spotMarketsService.selectedMarket;
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
        ? this.selectedMarket.second_token.shortName
        : this.selectedMarket.first_token.shortName;
      const _amount = isBuy
        ? (price * amount).toFixed(4)
        : (amount || 0).toFixed(4);
      return `${_amount} ${tokenName}`;
    }

    getMaxAmount(isBuy: boolean) {
      if (!this.currentAddress) return '0';
      if (!this.buySellGroup?.controls?.['price']?.value) return '0';
      const _price = this.buySellGroup.value['price'];
      const price = parseFloat((_price).toFixed(5));

      const propId = isBuy
        ? this.selectedMarket.second_token.propertyId
        : this.selectedMarket.first_token.propertyId;

      const getAvailable = (propId: number) => {
        if (propId === 999) {
          const balanceObj = this.balanceService.getFiatBalancesByAddress();
          const { confirmed, locked } = balanceObj;
          const _available = (confirmed - locked).toFixed(6);
          return parseFloat(_available);
        } else {
          const balanceObj = this.balanceService.getTokensBalancesByAddress();
          const tokenBalance = balanceObj?.find(t => t.propertyid === propId);
          if (!tokenBalance) return 0;
          const { balance, locked } = tokenBalance;
          const _available = (balance - locked).toFixed(6);
          return parseFloat(_available);
        }
      };

      const fee = 0.01; // 0.01;
      const _available = getAvailable(propId) - fee;
      const available = parseFloat((_available).toFixed(6));
      if (!available || ((available / price) <= 0)) return '0';
      const max = isBuy ? (available / price).toFixed(4) : available.toFixed(4);
      return max;
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
      const propId = isBuy
        ? this.selectedMarket.second_token.propertyId
        : this.selectedMarket.first_token.propertyId;
      
      if (propId === 999) {
        const v = this.buySellGroup.value.amount <= this.getMaxAmount(isBuy);
        return !this.buySellGroup.valid || !v ;
      } else {
        const v = this.buySellGroup.value.amount <= this.getMaxAmount(isBuy);

        const balanceObj = this.balanceService.getFiatBalancesByAddress();
        const { confirmed, locked } = balanceObj;
        const _available = (confirmed - locked).toFixed(6);
        const available =  parseFloat(_available);
        const v2 = available > 0.01; 
        return !this.buySellGroup.valid || !v || !v2;
      }

    }

    private trackPriceHandler() {
      this.spotOrderbookService.outsidePriceHandler
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
