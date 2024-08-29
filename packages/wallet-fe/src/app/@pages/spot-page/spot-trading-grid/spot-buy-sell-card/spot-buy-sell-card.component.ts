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
import { DialogService, DialogTypes } from 'src/app/@core/services/dialogs.service';
import { LoadingService } from 'src/app/@core/services/loading.service';
import { RpcService } from 'src/app/@core/services/rpc.service';
import { IMarket, IToken, SpotMarketsService } from 'src/app/@core/services/spot-services/spot-markets.service';
import { SpotOrderbookService } from 'src/app/@core/services/spot-services/spot-orderbook.service';
import { ISpotTradeConf, SpotOrdersService } from 'src/app/@core/services/spot-services/spot-orders.service';
import { IUTXO } from 'src/app/@core/services/txs.service';
import { PasswordDialog } from 'src/app/@shared/dialogs/password/password.component';
import { safeNumber } from 'src/app/utils/common.util';

const minFeeLtcPerKb = 0.0001;
const minVOutAmount = 0.0000546;

@Component({
  selector: 'tl-spot-buy-sell-card',
  templateUrl: './spot-buy-sell-card.component.html',
  styleUrls: ['./spot-buy-sell-card.component.scss'],
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
      private attestationService: AttestationService,
      private loadingService: LoadingService,
      private rpcService: RpcService,
      private apiService: ApiService,
      public matDialog: MatDialog,
      private dialogService: DialogService,
    ) {}

    get spotKeyPair() {
      return this.authService.walletAddresses[0];
    }

    get spotAddress() {
      return this.spotKeyPair;
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

    get reLayerApi() {
      return this.apiService.tlApi;
    }

    ngOnInit() {
      this.buildForms();
      this.trackPriceHandler();
    }

    private buildForms() {
      this.buySellGroup = this.fb.group({
        price: [null, [Validators.required, Validators.min(0.0001)]],
        amount: [null, [Validators.required, Validators.min(0.00000001)]],
      })
    }

    fillMax(isBuy: boolean) {
      const value = this.getMaxAmount(isBuy);
      this.buySellGroup?.controls?.['amount'].setValue(value);
      // tricky update the Max Amount 
      const value2 = this.getMaxAmount(isBuy);
      this.buySellGroup?.controls?.['amount'].setValue(value2);
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

        let _available;
        if (propId === -1 || propId === 0) {
            // Handle LTC balance
            _available = safeNumber(this.balanceService.getCoinBalancesByAddress(this.spotAddress)?.confirmed - this.getFees(isBuy));
        } else {
            // Handle other tokens
            _available = this.balanceService.getTokensBalancesByAddress(this.spotAddress)
                ?.find((t: any) => t.propertyid === propId)
                ?.available;
        }

        const inOrderBalance = this.getInOrderAmount(propId);
        const available = safeNumber((_available || 0) - inOrderBalance);
        
        if (!available || ((available / price) <= 0)) return 0;

        const _max = isBuy ? (available / price) : available;
        const max = safeNumber(_max);
        
        return max;
    }

    async handleBuySell(isBuy: boolean) {
      const fee = this.getFees(isBuy);
      const available = safeNumber((this.balanceService.getCoinBalancesByAddress(this.spotAddress)?.confirmed || 0) - fee)
      if (available < 0) {
        this.toastrService.error(`You need at least: ${fee} LTC for this trade`);
        return;
      }
      // const isKYC = this.attestationService.getAttByAddress(this.spotAddress);
      // if (isKYC !== true) {
      //   this.toastrService.error(`Spot Address Need Attestation first!`, 'Attestation Needed');
      //   return;
      // }
      const amount = this.buySellGroup.value.amount;
      const _price = this.buySellGroup.value.price;
      const price = this.isLimitSelected ? _price : this.currentPrice;

      const market = this.selectedMarket;
      const propIdForSale = isBuy ? market.second_token.propertyId : market.first_token.propertyId;
      const propIdDesired = isBuy ? market.first_token.propertyId : market.second_token.propertyId;
      console.log('checking buySell logic '+Boolean(propIdForSale)+' '+Boolean(propIdDesired)+' '+Boolean(!price && this.isLimitSelected)+' '+Boolean(!amount)+Boolean(!this.spotKeyPair))
      if (propIdForSale == null || propIdDesired == null || (!price && this.isLimitSelected) || amount == null) {
        return console.log('missing parameters for trade ' + propIdForSale + ' ' + propIdDesired + ' ' + price + ' ' + this.isLimitSelected+ ' ' + amount);
      }

      if (!this.spotKeyPair){
        return console.log('missing key pair')
      } 
  
      const pubkeyRes = await this.rpcService.rpc("getaddressinfo", [this.spotKeyPair]);
      if (pubkeyRes.error || !pubkeyRes.data?.pubkey) throw new Error(pubkeyRes.error || "No Pubkey Found");
      const pubkey = pubkeyRes.data.pubkey;

      const order: ISpotTradeConf = { 
        keypair: {
          address: this.spotKeyPair,
          pubkey: pubkey,
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
      console.log('about to place trade '+JSON.stringify(order))
      this.spotOrdersService.newOrder(order);
      this.buySellGroup.reset();
    }

    stopLiquidity() {
      console.log(`Stop Liquidity`);
    }

    /*addLiquidity(_amount: string, _orders_number: string, _range: string) {
       const amount = parseFloat(_amount);
       const orders_number = parseFloat(_orders_number);
       const range = parseFloat(_range);
       console.log({ amount, orders_number, range });
      return;
       const price = this.spotOrderbookService.lastPrice;
       const orders: ISpotTradeConf[] = [];
       const availableLtc = this.balanceService.getCoinBalancesByAddress(this.spotAddress)?.confirmed;
       const first =  this.selectedMarket.first_token.propertyId;
       const second = this.selectedMarket.second_token.propertyId;

       const availableFirst = first === -1
         ? this.balanceService.getCoinBalancesByAddress(this.spotAddress)?.confirmed
         : this.balanceService.getTokensBalancesByAddress(this.spotAddress)
           ?.find((t: any) => t.propertyid === first)
           ?.balance;

       const availableSecond = second === -1
         ? this.balanceService.getCoinBalancesByAddress(this.spotAddress)?.confirmed
         : this.balanceService.getTokensBalancesByAddress(this.spotAddress)
           ?.find((t: any) => t.propertyid === second)
           ?.balance;
      
       if (!availableFirst || !availableSecond || availableFirst < 1 || availableSecond < 1) {
         this.toastrService.error(`You Need At least balance of 1 from each: ${this.selectedMarket.pairString}`);
         return;
       }

       for (let i = 1; i < 11; i++) {
         const rawOrder = { 
           keypair: {
             address: this.spotKeyPair?.address,
             pubkey: this.spotKeyPair?.pubkey,
           },
           isLimitOrder: this.isLimitSelected,
           marketName: this.selectedMarket.pairString,
         };

         const buyProps = {
           id_desired: this.selectedMarket.second_token.propertyId,
           id_for_sale: this.selectedMarket.first_token.propertyId,
           amount: safeNumber(availableFirst / 10),
           price: safeNumber(price + i* (price / 10)),
         };

         const sellProps = {
           id_desired: this.selectedMarket.first_token.propertyId,
           id_for_sale: this.selectedMarket.second_token.propertyId,
           amount: safeNumber(availableSecond / 10),
           price: safeNumber(price - i* (price / 10)),
         };

         const buyOrder: ISpotTradeConf = {
           ...rawOrder, 
           type:"SPOT", 
           action: "SELL", 
           props: buyProps,
         };

         const sellOrder: ISpotTradeConf = {
           ...rawOrder, 
           type:"SPOT", 
           action: "BUY", 
           props: sellProps,
         };

         orders.push(buyOrder, sellOrder)
       }
       this.spotOrdersService.addLiquidity(orders);
    }*/

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
    //   if (this.authService.walletKeys.spot.length) {
    //     this.toastrService.error('The Limit of Spot Addresses is Reached');
    //     return;
    //   }
    //   const passDialog = this.matDialog.open(PasswordDialog);
    //   const password = await passDialog.afterClosed()
    //       .pipe(first())
    //       .toPromise();
  
    //   if (!password) return;
    //   await this.authService.addKeyPair(EAddress.SPOT, password);

    //   if (this.rpcService.NETWORK?.endsWith('TEST') && this.authService.activeSpotKey?.address) {
    //     const fundRes = await this.reLayerApi.fundTestnetAddress(this.authService.activeSpotKey.address).toPromise();
    //     if (fundRes.error || !fundRes.data) {
    //         this.toastrService.warning(fundRes.error, 'Faucet Error');
    //     } else {
    //         this.toastrService.success(`${this.authService.activeSpotKey?.address} was Fund with small amount tLTC`, 'Testnet Faucet')
    //     }
    // }
    }

    getNameBalanceInfo(token: IToken) {
      let _balance;
      if (token.propertyId === 0) {
        _balance = this.balanceService.getCoinBalancesByAddress(this.spotAddress)?.confirmed;
      } else {
        _balance = this.balanceService.getTokensBalancesByAddress(this.spotAddress)
          ?.find(e => e.propertyid === token.propertyId)?.available;
      }
      const inOrderBalance = this.getInOrderAmount(token.propertyId);
      const balance = safeNumber((_balance || 0) - inOrderBalance);
      return [token.fullName, `${balance > 0 ? balance : 0} ${token.shortName}`];
    }


    private getInOrderAmount(propertyId: number) {
      const num = this.spotOrdersService.openedOrders.map(o => {
        const { amount, price, id_for_sale } = o.props;
        if (propertyId === -1) {
          if (id_for_sale === -1) return safeNumber(amount * price);
          return 0.001;
        } else {
          if (id_for_sale === propertyId) return safeNumber(amount * price);
          return 0;
        }
      }).reduce((a, b) => a + b, 0);
      return safeNumber(num);
    }
  
    isSpotAddressSelfAtt() {
      const isKYC = this.attestationService.getAttByAddress(this.spotAddress);
      return isKYC === true ? "YES" : "NO";
    }

    ngOnDestroy() {
      this.destroyed$.next(true);
      this.destroyed$.complete();
    }

    getFees(isBuy: boolean) {
      const { amount, price } = this.buySellGroup.value;
      if (!amount || !price) return 0;

      const propId = isBuy
        ? this.selectedMarket.second_token.propertyId
        : this.selectedMarket.first_token.propertyId;

      const finalInputs: number[] = [];
      const _amount = propId !== -1
        ? safeNumber(minVOutAmount * 2)
        : safeNumber((amount * price) + minVOutAmount);
      const _allAmounts = this.balanceService.getCoinBalancesByAddress(this.spotAddress).utxos
        .map(r => r.amount)
        .sort((a, b) => b - a);
      const allAmounts =  propId !== -1
        ? _allAmounts
        : [minVOutAmount, ..._allAmounts]
      allAmounts.forEach(u => {
        const _amountSum: number = finalInputs.reduce((a, b) => a + b, 0);
        const amountSum = safeNumber(_amountSum);
        const _fee = safeNumber((0.3 * minFeeLtcPerKb) * (finalInputs.length + 1));
        if (amountSum < safeNumber(_amount + _fee)) finalInputs.push(u);
      });
      return safeNumber((0.3 * minFeeLtcPerKb) * (finalInputs.length));
    }

    closeAll() {
      this.spotOrdersService.closeAllOrders();
    }

    transfer() {
      const data = {
        firstToken: this.selectedMarket.first_token,
        secondToken: this.selectedMarket.second_token,
        address: this.spotAddress,
      };
  
      this.dialogService.openDialog(DialogTypes.TRANSFER, { data });
    }
}
