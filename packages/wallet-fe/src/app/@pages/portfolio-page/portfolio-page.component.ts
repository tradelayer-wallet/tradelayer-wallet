import { Component, OnInit } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { ToastrService } from 'ngx-toastr';
import { first } from 'rxjs/operators';
import { AddressService, IKeyPair } from 'src/app/@core/services/address.service';
import { AuthService } from 'src/app/@core/services/auth.service';
import { BalanceService } from 'src/app/@core/services/balance.service';
import { DialogService, DialogTypes } from 'src/app/@core/services/dialogs.service';
import { RpcService } from 'src/app/@core/services/rpc.service';
import { PasswordDialog } from 'src/app/@shared/dialogs/password/password.component';
import { decryptKeyPair, encryptKeyPair } from 'src/app/utils/litecore.util';

@Component({
  selector: 'tl-portoflio-page',
  templateUrl: './portfolio-page.component.html',
  styleUrls: ['./portfolio-page.component.scss']
})
export class PortfolioPageComponent implements OnInit{
  cryptoBalanceColumns: string[] = ['address', 'available', 'reserved', 'total', 'actions'];
  tokensBalanceColums: string[] = ['propertyid', 'name', 'available', 'locked', 'reserved', 'actions'];
  
  constructor(
    private balanceService: BalanceService,
    private addressService: AddressService,
    private dialogService: DialogService,
    private toastrService: ToastrService,
    private rpcService: RpcService,
    private authService: AuthService,
    private matDialog: MatDialog,
  ) {}

  get fiatBalance() {
    return Object.keys(this.allBalances)
      .map(address => ({ address, ...(this.allBalances?.[address]?.fiatBalance || {}) }));
  }

  get tokensBalances() {
    return this.balanceService.getTokensBalancesByAddress();
  }

  get selectedAddress() {
    return this.addressService.activeKeyPair?.address;
  }

  get allBalances() {
    return this.balanceService.allBalances;
  }
 
  get nonSynced() {
    return this.rpcService.isOffline || !this.rpcService.isSynced;
  }

  get isApiRPC() {
    return this.rpcService.isApiRPC;
  }

  ngOnInit() {}

  getAvailableFiatBalance(element: any) {
    const confirmed = element?.confirmed || 0;
    const locked = element?.locked || 0;
    const _available = confirmed - locked;
    const available = _available <= 0 ? 0 : _available;
    return available.toFixed(5);
  }

  getReservedFiatBalance(element: any) {
    const locked = element?.locked || 0;
    return locked.toFixed(5);
  }

  getTotalFiatBalnace(element: any) {
    const confirmed = element?.confirmed || 0;
    const unconfirmed = element?.unconfirmed || 0;

    return `${confirmed.toFixed(3)}/${unconfirmed.toFixed(3)}`
  }

  getAvailableTokensBalance(element: any) {
    const balance = element?.balance || 0;
    const locked = element?.locked || 0;
    const _available = balance - locked;
    const available = _available <= 0 ? 0 : _available;
    return available.toFixed(5);
  }

  getLockedTokensBalance(element: any) {
    const locked = element?.locked || 0;
    return locked.toFixed(5);
  }

  getReservedTokensBalance(element: any) {
    const locked = element?.reserved || 0;
    return locked.toFixed(5);
  }

  openDialog(dialog: string, _address?: any, _propId?: number) {
    if (this.nonSynced && !this.isApiRPC) {
      this.toastrService.warning('Not Allowed on offline wallet', 'Warning');
      return;
    }

    if (dialog === 'deposit') {
      const data = { address: _address || this.selectedAddress };
      this.dialogService.openDialog(DialogTypes.DEPOSIT, { disableClose: false, data });
    }

    if (dialog === 'withdraw') {
      const data = { address: _address || this.selectedAddress, propId: _propId };
      this.dialogService.openDialog(DialogTypes.WITHDRAW, { disableClose: false, data });
    }
  }

  async newAddress() {
    const passDialog = this.matDialog.open(PasswordDialog);
    const password = await passDialog.afterClosed()
        .pipe(first())
        .toPromise();
    if (!password) return;
    const encKey = this.authService.encKey;
    const decryptResult = decryptKeyPair(encKey, password);
    if (!decryptResult) {
        this.toastrService.error('Wrong Password', 'Error');
    } else {
      const pair = await this.addressService.generateNewKeyPair() as IKeyPair;
      this.addressService.addDecryptedKeyPair(pair);
      const allKeyParis = [
          ...this.addressService.keyPairs, 
          ...this.addressService.multisigPairs, 
          ...this.addressService.rewardAddresses,
          ...this.addressService.liquidityAddresses,
      ];
      this.balanceService.updateBalances();
      this.authService.encKey = encryptKeyPair(allKeyParis, password);
      this.dialogService.openEncKeyDialog(this.authService.encKey);
    }
  }

  copy(text: string) {
    navigator.clipboard.writeText(text);
    this.toastrService.info('Address Copied to clipboard', 'Copied')
  }
}