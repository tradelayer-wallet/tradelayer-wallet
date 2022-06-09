import { Component, OnInit } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { ToastrService } from 'ngx-toastr';
import { first } from 'rxjs/operators';
// import { AddressService, IKeyPair } from 'src/app/@core/services/address.service';
import { AuthService, IKeyPair } from 'src/app/@core/services/auth.service';
import { DialogService } from 'src/app/@core/services/dialogs.service';
import { LiquidityProviderService } from 'src/app/@core/services/liquidity-provider.service';
import { RpcService } from 'src/app/@core/services/rpc.service';
import { PasswordDialog } from 'src/app/@shared/dialogs/password/password.component';
import { decrypt, encrypt } from 'src/app/utils/crypto.util';

@Component({
  selector: 'tl-lp-page',
  templateUrl: './liquidity-provider.component.html',
  styleUrls: ['./liquidity-provider.component.scss']
})
export class LiquidityProviderPageComponent implements OnInit {
  rewardTableColumns: string[] = ['address', 'balance-ltc', 'balance-tokens', 'actions'];
  rawBalanceObj: any = {};

  constructor(
    private matDialog: MatDialog,
    private authService: AuthService,
    private toastrService: ToastrService,
    // private addressService: AddressService,
    private dialogService: DialogService,
    private liquidityProviderService: LiquidityProviderService,
    private rpcService: RpcService,
  ) {}

  get isLiquidityStarted() {
    return this.liquidityProviderService.isLiquidityStarted;
  }

  get liquidityAddresses(): IKeyPair[] {
    return this.liquidityProviderService.liquidityAddresses
  }

  ngOnInit(): void {
      this.liquidityAddresses.forEach(a => this.getBalanceForAddress(a));
  }

  async generateLiquidityAddresses() {
    // if (this.liquidityAddresses?.length > 0) return;
    // const passDialog = this.matDialog.open(PasswordDialog);
    // const password = await passDialog.afterClosed()
    //     .pipe(first())
    //     .toPromise();
    // if (!password) return;
    // const encKey = this.authService.encKey;
    // const decryptResult = decrypt(encKey, password);
    // if (!decryptResult) {
    //     this.toastrService.error('Wrong Password', 'Error');
    // } else {
    //   await this.addressService.generateLiquidityAddress();
    //   const allKeyParis = [
    //       ...this.addressService.keyPairs, 
    //       ...this.addressService.multisigPairs, 
    //       ...this.addressService.rewardAddresses,
    //       ...this.addressService.liquidityAddresses,
    //   ];
    //   this.authService.encKey = encryptKeyPair(allKeyParis, password);
    //   this.dialogService.openEncKeyDialog(this.authService.encKey);
    //   this.liquidityAddresses.forEach(a => this.getBalanceForAddress(a));
    // }
  }

  copy(text: string) {
    navigator.clipboard.writeText(text);
    this.toastrService.info('Address Copied to clipboard', 'Copied')
  }

  async getBalanceForAddress(pair: IKeyPair) {
    this.rawBalanceObj[pair.address] = { ltc: '-', tokens: '-' };
    const resLtc = await this.rpcService.smartRpc('listunspent', [0, 999999999, [pair.address]]);
    if (resLtc.error || !resLtc.data) {
      this.rawBalanceObj[pair.address].ltc = '-';
    } else {
      const sumLtc = resLtc.data
        .filter((e: any) => parseFloat(e.confirmations) > 0)
        .map((a: any) => parseFloat(a.amount))
        .reduce((a: any, b: any) => a + b, 0);
      this.rawBalanceObj[pair.address].ltc = sumLtc || sumLtc === 0 ? sumLtc.toFixed(6) : '-';
    }

    const resTokens= await this.rpcService.smartRpc('tl_getbalance', [pair.address, 4]);
    if (resTokens.error || !resTokens.data) {
      this.rawBalanceObj[pair.address].tokens = '-';
    } else {
      const sumTokens = parseFloat(resTokens.data?.balance) || 0;
      this.rawBalanceObj[pair.address].tokens = sumTokens?.toFixed(6) || '-';
    }
  }

  startLiquidity(pair: IKeyPair) {
    if (parseFloat(this.rawBalanceObj[pair.address].ltc) < 0.1 || parseFloat(this.rawBalanceObj[pair.address].tokens) < 10) {
      this.toastrService.error('Need at least 0.1 LTC and 10 wETH');
      return;
    }
    const options = {
      address: pair.address,
      pubKey: pair.pubkey,
      marketName: 'wETH/LTC',
      first_token: 4,
      second_token: -1,
      price: 0.1,
    }
    this.liquidityProviderService.startLiquidityProviding(options);
  }

  stopLiquidity(pair: IKeyPair) {
    this.liquidityProviderService.stopLiquidityProviding(pair.address);
  }
}