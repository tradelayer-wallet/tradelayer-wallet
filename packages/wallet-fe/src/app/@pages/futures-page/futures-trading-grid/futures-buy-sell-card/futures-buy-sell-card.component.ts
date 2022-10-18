import { Component, OnDestroy, OnInit } from '@angular/core';
import { FormBuilder, FormGroup, Validators } from '@angular/forms';
import { MatDialog } from '@angular/material/dialog';
import { ToastrService } from 'ngx-toastr';
import { ReplaySubject } from 'rxjs';
import { first, takeUntil } from 'rxjs/operators';
import { ApiService } from 'src/app/@core/services/api.service';
import { AttestationService } from 'src/app/@core/services/attestation.service';
import { AuthService, EAddress } from 'src/app/@core/services/auth.service';
import { BalanceService } from 'src/app/@core/services/balance.service';
import { FuturesMarketService, IFutureMarket, IToken } from 'src/app/@core/services/futures-services/futures-markets.service';
import { FuturesOrderbookService } from 'src/app/@core/services/futures-services/futures-orderbook.service';
import { FuturesOrdersService, IFuturesTradeConf } from 'src/app/@core/services/futures-services/futures-orders.service';
import { LoadingService } from 'src/app/@core/services/loading.service';
import { RpcService } from 'src/app/@core/services/rpc.service';
import { PasswordDialog } from 'src/app/@shared/dialogs/password/password.component';
import { safeNumber } from 'src/app/utils/common.util';

const minFeeLtcPerKb = 0.002;
const minVOutAmount = 0.000036;

@Component({
  selector: 'tl-futures-buy-sell-card',
  templateUrl: './futures-buy-sell-card.component.html',
  styleUrls: ['../../../spot-page/spot-trading-grid/spot-buy-sell-card/spot-buy-sell-card.component.scss'],
})
export class FuturesBuySellCardComponent implements OnInit, OnDestroy {
    private destroyed$: ReplaySubject<boolean> = new ReplaySubject(1);
    private _isLimitSelected: boolean = true;
    public buySellGroup: FormGroup = new FormGroup({});

    constructor(
      private futuresMarketService: FuturesMarketService,
      private balanceService: BalanceService,
      private fb: FormBuilder,
      private authService: AuthService,
      private toastrService: ToastrService,
      private attestationService: AttestationService,
      private loadingService: LoadingService,
      private rpcService: RpcService,
      private apiService: ApiService,
      private futuresOrdersService: FuturesOrdersService,
      private futuresOrderbookService: FuturesOrderbookService,
      public matDialog: MatDialog,
    ) {}

    get futureKeyPair() {
      return this.authService.walletKeys?.futures?.[0];
    }

    get futureAddress() {
      return this.futureKeyPair?.address;
    }

    get isLoading(): boolean {
      return this.loadingService.tradesLoading;
    }

    get selectedMarket(): IFutureMarket {
      return this.futuresMarketService.selectedMarket
    }

    get currentPrice() {
      return this.futuresOrderbookService.currentPrice;
    }

    get isLimitSelected() {
      return this._isLimitSelected;
    }

    set isLimitSelected(value: boolean) {
      this._isLimitSelected = value;
      this.buySellGroup.controls.price.setValue(this.currentPrice);
    }

    get reLayerApi() {
      return this.apiService.tlApi;
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
      // tricky update the Max Amount 
      const value2 = this.getMaxAmount(isBuy);
      this.buySellGroup?.controls?.['amount'].setValue(value2);
    }

    getMaxAmount(isBuy: boolean) {
      if (!this.futureAddress) return 0;
      if (!this.buySellGroup?.controls?.['price']?.value && this.isLimitSelected) return 0;
      const _price = this.isLimitSelected 
        ? this.buySellGroup.value['price'] 
        : this.currentPrice;
      const price = safeNumber(_price);

      const propId = this.selectedMarket.collateral.propertyId;

      const _available = this.balanceService.getTokensBalancesByAddress(this.futureAddress)
        ?.find((t: any) => t.propertyid === propId)
        ?.balance;
      const inOrderBalance = this.getInOrderAmount(propId);
      const available = safeNumber((_available || 0 )- inOrderBalance);
      if (!available || ((available / price) <= 0)) return 0;
      const _max = isBuy ? (available / price) : available;
      const max = safeNumber(_max);
      return max;
    }


    handleBuySell(isBuy: boolean) {
      const fee = this.getFees(isBuy);
      const available = safeNumber((this.balanceService.getCoinBalancesByAddress(this.futureAddress)?.confirmed || 0) - fee)
      if (available < 0) {
        this.toastrService.error(`You need at least: ${fee} LTC for this trade`);
        return;
      }
      const isKYC = this.attestationService.getAttByAddress(this.futureAddress);
      if (isKYC !== true) {
        this.toastrService.error(`Futures Address Need KYC first!`, 'KYC Needed');
        return;
      }
      const amount = this.buySellGroup.value.amount;
      const _price = this.buySellGroup.value.price;
      const price = this.isLimitSelected ? _price : this.currentPrice;
      const levarage = 1;
      const market = this.selectedMarket;
      const collateral = market.collateral.propertyId;
      const contract_id = market.contract_id;

      if (!contract_id || (!price && this.isLimitSelected) || !amount) return;
      if (!this.futureKeyPair) return;
  
      const order: IFuturesTradeConf = { 
        keypair: {
          address: this.futureKeyPair?.address,
          pubkey: this.futureKeyPair?.pubkey,
        },
        action: isBuy ? "BUY" : "SELL",
        type: "FUTURES",
        props: {
          contract_id: contract_id,
          amount: amount,
          price: price,
          collateral: collateral,
          levarage: levarage,
        },
        isLimitOrder: this.isLimitSelected,
        marketName: this.selectedMarket.pairString,
      };
      this.futuresOrdersService.newOrder(order);
      this.buySellGroup.reset();
    }

    addLiquidity() {
      this.toastrService.error('Not Allowed', 'Error');
      return;
    }

    getButtonDisabled(isBuy: boolean) {
      const v = this.buySellGroup.value.amount <= this.getMaxAmount(isBuy);
      return !this.buySellGroup.valid || !v;
    }

    private trackPriceHandler() {
      this.futuresOrderbookService.outsidePriceHandler
        .pipe(takeUntil(this.destroyed$))
        .subscribe(price => {
          this.buySellGroup.controls['price'].setValue(price);
        });
    }

    async newFutureAddress() {
      if (this.authService.walletKeys.futures.length) {
        this.toastrService.error('The Limit of Futures Addresses is Reached');
        return;
      }
      const passDialog = this.matDialog.open(PasswordDialog);
      const password = await passDialog.afterClosed()
          .pipe(first())
          .toPromise();
  
      if (!password) return;
      await this.authService.addKeyPair(EAddress.FUTURES, password);

      if (this.rpcService.NETWORK?.endsWith('TEST') && this.authService.activeFuturesKey?.address) {
        const fundRes = await this.reLayerApi.fundTestnetAddress(this.authService.activeFuturesKey.address).toPromise();
        if (fundRes.error || !fundRes.data) {
            this.toastrService.warning(fundRes.error, 'Faucet Error');
        } else {
            this.toastrService.success(`${this.authService.activeFuturesKey?.address} was Fund with small amount tLTC`, 'Testnet Faucet')
        }
    }
    }

    getNameBalanceInfo(token: IToken) {
      const _balance = token.propertyId === -1
        ? this.balanceService.getCoinBalancesByAddress(this.futureAddress).confirmed
        : this.balanceService.getTokensBalancesByAddress(this.futureAddress)
          ?.find(e => e.propertyid === token.propertyId)?.balance;
      const inOrderBalance = this.getInOrderAmount(token.propertyId);
      const balance = safeNumber((_balance  || 0) - inOrderBalance);
      return [token.fullName, `${ balance > 0 ? balance : 0 } ${token.shortName}`];
    }

    private getInOrderAmount(propertyId: number) {
      const num = this.futuresOrdersService.openedOrders.map(o => {
        const { amount, price, collateral } = o.props;
        if (collateral === propertyId) return safeNumber(amount * price);
        return 0;
      }).reduce((a, b) => a + b, 0);
      return safeNumber(num);
    }
  
    isFutureAddressSelfAtt() {
      const isKYC = this.attestationService.getAttByAddress(this.futureAddress);
      return isKYC === true ? "YES" : "NO";
    }

    ngOnDestroy() {
      this.destroyed$.next(true);
      this.destroyed$.complete();
    }

    getFees(isBuy: boolean) {
      const { amount, price } = this.buySellGroup.value;
      if (!amount || !price) return 0;
      const finalInputs: number[] = [];
      const _amount = safeNumber((amount * price) + minVOutAmount);
      const _allAmounts = this.balanceService.getCoinBalancesByAddress(this.futureAddress).utxos
        .map(r => r.amount)
        .sort((a, b) => b - a);
      const allAmounts = [minVOutAmount, ..._allAmounts]
      allAmounts.forEach(u => {
        const _amountSum: number = finalInputs.reduce((a, b) => a + b, 0);
        const amountSum = safeNumber(_amountSum);
        const _fee = safeNumber((0.3 * minFeeLtcPerKb) * (finalInputs.length + 1));
        if (amountSum < safeNumber(_amount + _fee)) finalInputs.push(u);
      });
      return safeNumber((0.3 * minFeeLtcPerKb) * (finalInputs.length));
    }

    closeAll() {
      this.futuresOrdersService.closeAllOrders();
    }
}
