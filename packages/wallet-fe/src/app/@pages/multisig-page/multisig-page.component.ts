import { Component, OnInit } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { ToastrService } from 'ngx-toastr';
import { first } from 'rxjs/operators';
// import { AddressService, IMultisigPair } from 'src/app/@core/services/address.service';
import { ApiService } from 'src/app/@core/services/api.service';
import { AuthService } from 'src/app/@core/services/auth.service';
import { DialogService, DialogTypes } from 'src/app/@core/services/dialogs.service';
import { RpcService } from 'src/app/@core/services/rpc.service';
import { WindowsService } from 'src/app/@core/services/windows.service';
import { PasswordDialog } from 'src/app/@shared/dialogs/password/password.component';
import { decrypt, encrypt } from 'src/app/utils/crypto.util';

@Component({
  selector: 'tl-multisig-page',
  templateUrl: './multisig-page.component.html',
  styleUrls: ['./multisig-page.component.scss']
})
export class MultisigPageComponent implements OnInit{
  multisigTableColumns: string[] = ['address', 'nkeys', 'pvalue', 'keys', 'remove'];
  rawBalanceObj: any = {};

  constructor(
    private toastrService: ToastrService,
    private customDialogs: DialogService,
    // private addressService: AddressService,
    private authService: AuthService,
    private windowsService: WindowsService,
    private dialogService: DialogService,
    public matDialog: MatDialog,
    private apiService: ApiService,
    private rpcService: RpcService,
  ) {}

  get multisigs() {
    return []
  }

  get isLoggedIn() {
    return this.authService.isLoggedIn;;
  }

  get soChainApi() {
    return this.apiService.soChainApi;
  }

  ngOnInit() {
    if (!this.rpcService.isOffline) this.multisigs.forEach(e => this.getBalanceForMultisig(e));
  }

  async getBalanceForMultisig(pair: any) {
    this.rawBalanceObj[pair.address] = '-';
    if (this.rpcService.isOffline)  {
      this.toastrService.warning('Cant get multisig balance in Offline mode');
      return;
    }
    const res: any = await this.soChainApi.getTxUnspents(pair.address).toPromise();

    if (res.status !== 'success' || !res.data?.txs) {
      this.rawBalanceObj[pair.address] = '-';
    } else {
      const sum = res.data.txs.reduce((a: any, b: any) => parseFloat(b.value) + a, 0);
      this.rawBalanceObj[pair.address] = sum || sum === 0 ? sum.toFixed(6) : '-';
    }
  }

  newMultisig() {
    this.customDialogs.openDialog(DialogTypes.NEW_MULTISIG, { disableClose: false });
  }

  newTx(event: Event) {
    event.stopImmediatePropagation();
    this.windowsService.addTxBuilder();
  }

  copy(text: string) {
    navigator.clipboard.writeText(text);
    this.toastrService.info('Address Copied to clipboard', 'Copied')
  }

  async remove(el: any) {
    // const passDialog = this.matDialog.open(PasswordDialog);
    // const password = await passDialog.afterClosed()
    //     .pipe(first())
    //     .toPromise();
    // if (!password) return;
    // const encKey = this.authService.encKey;
    // const decryptResult = decryptKeyPair(encKey, password);
    // if (!decryptResult) {
    //     this.toastrService.error('Wrong Password', 'Error');
    // } else {
    //   this.addressService.removeMultisigAddress(el);
    //   const allKeyParis = [
    //     ...this.addressService.keyPairs,
    //     ...this.addressService.multisigPairs,
    //     ...this.addressService.rewardAddresses,
    //     ...this.addressService.liquidityAddresses,
    //   ];
    //   this.authService.encKey = encryptKeyPair(allKeyParis, password);
    //   this.dialogService.openEncKeyDialog(this.authService.encKey);
    // }
  }
}
