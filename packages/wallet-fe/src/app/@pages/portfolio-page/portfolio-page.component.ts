import { AfterViewInit, Component, ElementRef, OnInit } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { ToastrService } from 'ngx-toastr';
import { first } from 'rxjs/operators';
import { AuthService, EAddress } from 'src/app/@core/services/auth.service';
import { BalanceService } from 'src/app/@core/services/balance.service';
import { DialogService, DialogTypes } from 'src/app/@core/services/dialogs.service';
import { RpcService } from 'src/app/@core/services/rpc.service';
import { PasswordDialog } from 'src/app/@shared/dialogs/password/password.component';

@Component({
  selector: 'tl-portoflio-page',
  templateUrl: './portfolio-page.component.html',
  styleUrls: ['./portfolio-page.component.scss']
})
export class PortfolioPageComponent {
  cryptoBalanceColumns: string[] = ['address', 'confirmed', 'unconfirmed', 'actions'];
  tokensBalanceColums: string[] = ['propertyid', 'name', 'balance', 'actions'];
  selectedAddress: string = '';

  constructor(
    private balanceService: BalanceService,
    private dialogService: DialogService,
    private toastrService: ToastrService,
    private authService: AuthService,
    private elRef: ElementRef,
    public matDialog: MatDialog
  ) {}

  get coinBalance() {
    return Object.keys(this.balanceService.allBalances)
      .map(address => ({ address, ...( this.balanceService.allBalances?.[address]?.coinBalance || {}) }));
  }

  get tokensBalances() {
    return this.balanceService.getTokensBalancesByAddress(this.selectedAddress);
  }

  openDialog(dialog: string, address?: any, _propId?: number) {
    const data = { address, propId: _propId };
    const TYPE = dialog === 'deposit'
      ? DialogTypes.DEPOSIT
      : dialog === 'withdraw'
        ? DialogTypes.WITHDRAW
        : null;
    if (!TYPE || !data) return;
    this.dialogService.openDialog(TYPE, { disableClose: false, data });
  }

  async newAddress() {
    const passDialog = this.matDialog.open(PasswordDialog);
    const password = await passDialog.afterClosed()
        .pipe(first())
        .toPromise();

    if (!password) return;
    this.authService.addKeyPair(EAddress.MAIN, password);
  }

  showTokens(address: string) {
    this.selectedAddress = address;
    try {
        const { nativeElement } = this.elRef;
        setTimeout(() => nativeElement.scrollTop = nativeElement.scrollHeight);
    } catch(err) { }   
  }

  copy(text: string) {
    navigator.clipboard.writeText(text);
    this.toastrService.info('Address Copied to clipboard', 'Copied');
  }
}