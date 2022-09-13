import { Component, OnDestroy, OnInit } from '@angular/core';
import { FormBuilder, FormGroup, Validators } from '@angular/forms';
import { MatDialog } from '@angular/material/dialog';
import { ToastrService } from 'ngx-toastr';
import { ReplaySubject } from 'rxjs';
import { first, takeUntil } from 'rxjs/operators';
import { AttestationService } from 'src/app/@core/services/attestation.service';
import { AuthService, EAddress } from 'src/app/@core/services/auth.service';
import { BalanceService } from 'src/app/@core/services/balance.service';
import { LoadingService } from 'src/app/@core/services/loading.service';
import { IMarket, IToken, SpotMarketsService } from 'src/app/@core/services/spot-services/spot-markets.service';
import { SpotOrderbookService } from 'src/app/@core/services/spot-services/spot-orderbook.service';
import { ISpotTradeConf, SpotOrdersService } from 'src/app/@core/services/spot-services/spot-orders.service';
import { PasswordDialog } from 'src/app/@shared/dialogs/password/password.component';
import { safeNumber } from 'src/app/utils/common.util';

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
      private spotOrdersService: SpotOrdersService,
      private spotOrderbookService: SpotOrderbookService,
      private authService: AuthService,
      private toastrService: ToastrService,
      public matDialog: MatDialog,
      private attestationService: AttestationService,
      private loadingService: LoadingService,
    ) {}

    get spotKeyPair() {
      return this.authService.walletKeys?.spot?.[0];
    }

    get spotAddress() {
      return this.spotKeyPair?.address;
    }

    get isLoading(): boolean {
      return this.loadingService.tradesLoading;
    }

    get selectedMarket(): IMarket {
      return this.spotMarketsService.selectedMarket;
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
      if (!this.spotAddress) return 0;
      if (!this.buySellGroup?.controls?.['price']?.value && this.isLimitSelected) return 0;
      const _price = this.isLimitSelected 
        ? this.buySellGroup.value['price'] 
        : this.currentPrice;
      const price = safeNumber(_price);

      const propId = isBuy
        ? this.selectedMarket.second_token.propertyId
        : this.selectedMarket.first_token.propertyId;

      const _available = propId === -1
        ? this.balanceService.getCoinBalancesByAddress(this.spotAddress)?.confirmed
        : this.balanceService.getTokensBalancesByAddress(this.spotAddress)
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
      if (!this.spotKeyPair) return;
  
      const order: ISpotTradeConf = { 
        keypair: {
          address: this.spotKeyPair?.address,
          pubkey: this.spotKeyPair?.pubkey,
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
        marketName: this.selectedMarket.pairString,
      };
      this.spotOrdersService.newOrder(order);
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

    async newSpotAddress() {
      if (this.authService.walletKeys.spot.length) {
        this.toastrService.error('The Limit of Spot Addresses is Reached');
        return;
      }
      const passDialog = this.matDialog.open(PasswordDialog);
      const password = await passDialog.afterClosed()
          .pipe(first())
          .toPromise();
  
      if (!password) return;
      this.authService.addKeyPair(EAddress.SPOT, password);
    }

    getNameBalanceInfo(token: IToken) {
      const _balance = token.propertyId === -1
        ? this.balanceService.getCoinBalancesByAddress(this.spotAddress).confirmed
        : this.balanceService.getTokensBalancesByAddress(this.spotAddress)
          ?.find(e => e.propertyid === token.propertyId)?.balance;
      const balance = safeNumber(_balance || 0);
      return [token.fullName, `${balance} ${token.shortName}`];
    }

    isSpotAddressSelfAtt() {
      const isKYC = this.attestationService.getAttByAddress(this.spotAddress);
      return isKYC === true ? "YES" : "NO";
    }

    ngOnDestroy() {
      this.destroyed$.next(true);
      this.destroyed$.complete();
    }
}
