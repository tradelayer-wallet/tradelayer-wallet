import { Component, OnDestroy, OnInit } from '@angular/core';
import { FormBuilder, FormGroup, Validators } from '@angular/forms';
import { MatDialog } from '@angular/material/dialog';
import { ToastrService } from 'ngx-toastr';
import { ReplaySubject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { ApiService } from 'src/app/@core/services/api.service';
import { AttestationService } from 'src/app/@core/services/attestation.service';
import { AuthService, EAddress } from 'src/app/@core/services/auth.service';
import { BalanceService } from 'src/app/@core/services/balance.service';
import { FuturesMarketService, IFutureMarket, IToken } from 'src/app/@core/services/futures-services/futures-markets.service';
import { FuturesOrderbookService } from 'src/app/@core/services/futures-services/futures-orderbook.service';
import { FuturesOrdersService, IFuturesTradeConf } from 'src/app/@core/services/futures-services/futures-orders.service';
import { LoadingService } from 'src/app/@core/services/loading.service';
import { RpcService } from 'src/app/@core/services/rpc.service';
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
  public buyFee: number = 0;
  public sellFee: number = 0;
  public maxBuyAmount: number = 0;
  public maxSellAmount: number = 0;
  public nameBalanceInfo: string[] = [];
  public attestationStatus: string = '';

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
    return this.authService.walletAddresses[0];
  }

  get futureAddress() {
    return this.futureKeyPair;
  }

  get isLoading(): boolean {
    return this.loadingService.tradesLoading;
  }

  get selectedMarket(): IFutureMarket {
    return this.futuresMarketService.selectedMarket;
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

  ngOnInit() {
    this.buildForms();
    this.trackPriceHandler();

    this.buySellGroup.valueChanges.pipe(takeUntil(this.destroyed$)).subscribe(() => {
      this.maxBuyAmount = this.getMaxAmount();
      this.maxSellAmount = this.getMaxAmount();
      this.buyFee = this.calculateFee();
      this.sellFee = this.calculateFee();
    });

    this.nameBalanceInfo = this.getNameBalanceInfo(this.selectedMarket.collateral);
    this.attestationStatus = this.getAttestationStatus(this.futureAddress);
  }

  private buildForms() {
    this.buySellGroup = this.fb.group({
      price: [null, [Validators.required, Validators.min(0.01)]],
      amount: [null, [Validators.required, Validators.min(0.01)]],
    });
  }

  private trackPriceHandler() {
    this.futuresOrderbookService.outsidePriceHandler
      .pipe(takeUntil(this.destroyed$))
      .subscribe(price => {
        this.buySellGroup.controls['price'].setValue(price);
      });
  }

  getNameBalanceInfo(token: IToken): string[] {
    const rawBalance = token.propertyId === -1
      ? this.balanceService.getCoinBalancesByAddress(this.futureAddress).confirmed
      : this.balanceService.getTokensBalancesByAddress(this.futureAddress)?.find(e => e.propertyid === token.propertyId)?.available;

    const balance = safeNumber(rawBalance ?? 0);
    return [token.fullName, `${balance.toFixed(6)} ${token.shortName}`];
  }

  getAttestationStatus(address: string): string {
    const status = this.attestationService.getAttByAddress(address);
    switch (status) {
      case 'active': return 'YES';
      case 'inactive': return 'REVOKED';
      default: return 'NO';
    }
  }

  calculateInitialMargin(isInverse: boolean, amount: number, price: number, leverage: number, notional: number) {
    return isInverse
      ? safeNumber(((amount / price) / leverage) * notional)
      : safeNumber(((amount * price) / leverage) * notional);
  }

  calculateFee(): number {
    try {
      const { amount, price } = this.buySellGroup.value;
      const amt = safeNumber(amount);
      const prc = safeNumber(price);
      if (!amt || !prc || amt <= 0 || prc <= 0) return 0;
      const finalInputs: number[] = [];
      const _amount = (amt * prc) + minVOutAmount;
      const coinBalances = this.balanceService.getCoinBalancesByAddress(this.futureAddress);
      if (!coinBalances || !Array.isArray(coinBalances.utxos)) return 0;
      const allAmounts = [minVOutAmount, ...coinBalances.utxos.map(u => u.amount).sort((a, b) => b - a)];
      allAmounts.forEach(u => {
        const amountSum = safeNumber(finalInputs.reduce((a, b) => a + b, 0));
        const _fee = (0.3 * minFeeLtcPerKb) * (finalInputs.length + 1);
        if (amountSum < (_amount + _fee)) finalInputs.push(u);
      });
      return (0.3 * minFeeLtcPerKb) * (finalInputs.length);
    } catch (err) {
      console.error('Error in calculateFee:', err);
      return 0;
    }
  }

  getMaxAmount(): number {
    if (!this.futureAddress) return 0;
    const _price = this.isLimitSelected ? this.buySellGroup.value['price'] : this.currentPrice;
    const price = safeNumber(_price);
    if (!price || price <= 0) return 0;
    const market = this.selectedMarket;
    const propId = market?.collateral?.propertyId;
    if (!propId) return 0;
    const tokenBalanceObj = this.balanceService.getTokensBalancesByAddress(this.futureAddress)?.find((t: any) => t.propertyid === propId);
    let availableBalance = 0;
    let channelBalance = 0;
    if (tokenBalanceObj) {
      availableBalance = safeNumber(tokenBalanceObj.available || 0);
      channelBalance = safeNumber(tokenBalanceObj.channel || 0);
    }
    const tokenBalance = Math.max(availableBalance, channelBalance);
    const leverage = market.leverage || 10;
    const notional = market.notional || 1;
    return safeNumber((tokenBalance * leverage) / (price * notional));
  }

  handleBuySellBuy(): void {
    this.handleBuySell(true);
  }

  handleBuySellSell(): void {
    this.handleBuySell(false);
  }

  private handleBuySell(isBuy: boolean): void {
    const fee = this.calculateFee();
    const available = safeNumber((this.balanceService.getCoinBalancesByAddress(this.futureAddress)?.confirmed || 0) - fee);
    if (available < 0) {
      this.toastrService.error(`You need at least: ${fee} LTC for this trade`);
      return;
    }

    const amount = this.buySellGroup.value.amount;
    const _price = this.buySellGroup.value.price;
    const price = this.isLimitSelected ? _price : this.currentPrice;
    const market = this.selectedMarket;
    const leverage = market.leverage || 10;
    const notional = market.notional || 1;
    const isInverse = market.inverse || false;
    const initialMargin = this.calculateInitialMargin(isInverse, amount, price, leverage, notional);

    const pubkey = this.authService.activeFuturesKey?.pubkey;
    if (!pubkey) {
      this.toastrService.error('Missing pubkey');
      return;
    }

    const tokenBalance = this.balanceService.getTokensBalancesByAddress(this.futureAddress)?.find((t: any) => t.propertyid === market.collateral.propertyId);
    let availableBalance = 0;
    let channelBalance = 0;
    if (tokenBalance) {
      availableBalance = safeNumber(tokenBalance.available || 0);
      channelBalance = safeNumber(tokenBalance.channel || 0);
    }

    const transfer = initialMargin <= channelBalance ? true : initialMargin <= availableBalance ? false : null;
    if (transfer === null) {
      this.toastrService.error(`Insufficient collateral for this trade.`);
      return;
    }

    const order: IFuturesTradeConf = {
      keypair: {
        address: this.futureKeyPair,
        pubkey,
      },
      action: isBuy ? 'BUY' : 'SELL',
      type: 'FUTURES',
      props: {
        contract_id: market.contract_id,
        amount,
        price,
        collateral: market.collateral.propertyId,
        levarage: leverage,
        transfer,
      },
      isLimitOrder: this.isLimitSelected,
      marketName: market.pairString,
    };

    this.futuresOrdersService.newOrder(order);
    this.buySellGroup.reset();
  }

  getButtonDisabled(): boolean {
    return !this.buySellGroup.valid || this.buySellGroup.value.amount > this.getMaxAmount();
  }

  stopLiquidity() {
    console.log(`Stop Liquidity`);
  }

  closeAll() {
    this.futuresOrdersService.closeAllOrders();
  }

  ngOnDestroy() {
    this.destroyed$.next(true);
    this.destroyed$.complete();
  }
}
