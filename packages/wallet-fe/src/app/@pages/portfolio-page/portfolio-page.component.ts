import { AfterViewInit, Component, ElementRef, OnInit, ChangeDetectorRef,Inject } from '@angular/core';
import { ToastrService } from 'ngx-toastr';
import { first } from 'rxjs/operators';
import { AttestationService } from 'src/app/@core/services/attestation.service';
import { AuthService, EAddress } from 'src/app/@core/services/auth.service';
import { BalanceService } from 'src/app/@core/services/balance.service';
import { DialogService, DialogTypes } from 'src/app/@core/services/dialogs.service';
import { LoadingService } from 'src/app/@core/services/loading.service';
import { RpcService } from 'src/app/@core/services/rpc.service';
import { TxsService } from 'src/app/@core/services/txs.service';
import { PasswordDialog } from 'src/app/@shared/dialogs/password/password.component';
import { ENCODER } from 'src/app/utils/payloads/encoder'
import { HttpClient } from '@angular/common/http';
import { MAT_DIALOG_DATA, MatDialogRef, MatDialog } from '@angular/material/dialog';

@Component({
  selector: 'tl-portoflio-page',
  templateUrl: './portfolio-page.component.html',
  styleUrls: ['./portfolio-page.component.scss']
})
export class PortfolioPageComponent implements OnInit {
  walletAddresses: string[] = []; 
  cryptoBalanceColumns: string[] = ['attestation', 'address', 'confirmed', 'unconfirmed', 'actions'];
  tokensBalanceColums: string[] = ['propertyid', 'name', 'available', 'reserved', 'margin', 'channel', 'actions'];
  selectedAddress: string = '';
  private propertyTypeCache = new Map<number, number>(); // pid -> type (5 = synthetic)

  constructor(
    private balanceService: BalanceService,
    private dialogService: DialogService,
    private toastrService: ToastrService,
    private authService: AuthService,
    private elRef: ElementRef,
    public matDialog: MatDialog,
    private rpcService: RpcService,
    private txsService: TxsService,
    private attestationService: AttestationService,
    private loadingService: LoadingService,
    private cdr: ChangeDetectorRef, // Inject ChangeDetectorRef,
    private http: HttpClient
  ) {}

  get coinBalance() {
    return Object.keys(this.balanceService.allBalances)
      .map(address => ({ address, ...( this.balanceService.allBalances?.[address]?.coinBalance || {}) }));
  }

  get tokensBalances() {
    return this.balanceService.getTokensBalancesByAddress(this.selectedAddress);
  }

  get isAbleToRpc() {
    return this.rpcService.isAbleToRpc;
  }

  get isSynced() {
    return this.rpcService.isSynced;
  }

 ngOnInit(): void {
    this.authService.getAddressesFromWallet().then(() => {
        this.walletAddresses = this.authService.walletAddresses; // Ensure this happens after addresses are fetched
        this.startAttestationUpdateInterval();
    }).catch(error => {
        console.error('Error fetching wallet addresses:', error);
    });
}


    // Start periodic updates for attestation statuses
  startAttestationUpdateInterval() {
    this.updateAttestationStatuses(); // Run once on init
    setInterval(() => {
      this.updateAttestationStatuses(); 
      this.cdr.detectChanges(); // Force Angular to update the view
    }, 20000); // Update every 20 seconds
  }

  // Fetch and update attestation statuses for all wallet addresses
  async updateAttestationStatuses() {
    const addresses = this.authService.listOfallAddresses
    for (const address of addresses) {
      await this.attestationService.checkAttAddress(address);
    }
  }

  getAddressAttestationStatus(address: string): string | boolean {
      const attestation = this.attestationService.getAttByAddress(address);
      console.log(`Status for address ${address}:`, attestation || 'No data found');

      if (attestation === 'PENDING') {
          return 'PENDING';
      }

      // If attestation status is 'active', return true
      if (attestation === 'active') {
          return true;
      }

      // For any other status or false, return false
      return false;
  }



  shouldShowVesting(propertyId: number): boolean {
    // Show vesting column only for propertyId 2 and 3
    return propertyId === 2 || propertyId === 3;
  }

  getReservedOrVestingValue(element: any): string {
    if (element.propertyid === 2 || element.propertyid === 3) {
      // Display the vesting value
      return element.vesting !== undefined ? element.vesting.toFixed(6) : 'N/A';
    } else {
      // Display the reserved value
      return element.reserved !== undefined ? element.reserved.toFixed(6) : 'N/A';
    }
  }


  openDialog(dialog: string, address?: any, _propId?: number, _amount?:number) {
    const data = { address, propId: _propId, amount: _amount };

    let TYPE = null;
    if (dialog === 'deposit') {
      TYPE = DialogTypes.DEPOSIT;
    } else if (dialog === 'withdraw') {
      TYPE = DialogTypes.WITHDRAW;
    } else if (dialog === 'synth') {
      TYPE = DialogTypes.SYNTH;
    }

    if (!TYPE || !data) return;
    this.dialogService.openDialog(TYPE, { disableClose: false, data });
  }


  async newAddress() {
      try {
          // Call the RPC service to generate a new address
          const newAddressRes = await this.rpcService.rpc('getnewaddress', [this.authService.walletLabel]);

          // Check for errors in the RPC response
          if (newAddressRes.error) {
              this.toastrService.error('Failed to generate a new address', 'Error');
              console.error('Error from getnewaddress:', newAddressRes.error);
              return;
          }

          const newAddress = newAddressRes.data;

          if (!newAddress) {
              this.toastrService.error('No new address generated', 'Error');
              console.error('RPC response did not return an address:', newAddressRes);
              return;
          }

          // Add the new address to the AuthService wallet
          this.authService.walletAddresses = [...this.authService.walletAddresses, newAddress];

          // Notify the user
          this.toastrService.success('New address created successfully', 'Success');
          console.log('New Address:', newAddress);

      } catch (error) {
          this.toastrService.error('Failed to generate a new address', 'Error');
          console.error('Error while generating a new address:', error);
      }
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


    async selfAttestate(address: string) {
      try {
          this.loadingService.isLoading = true;
          //const ipToCheck = await this.rpcService.rpc('tl_getIpByAddress', [address]);
          const ipCheckResult = await this.attestationService.checkIP();

          const countryCode = ipCheckResult.attestation.country

          const bannedCountries = ["US", "KP", "SY", "SD", "RU", "IR"];
          
          if (bannedCountries.includes(countryCode.toUpperCase())) {
            this.toastrService.error('Cannot attest addresses originating from a sanctioned country.', `Address: ${address}`);
            return;
          }

         

          const attestationPayload = ENCODER.encodeAttestation({
              revoke: 0,
              id: 0,
              targetAddress: address,
              metaData: countryCode,
          });

          const res = await this.txsService.buildSingSendTx({
              fromKeyPair: { address },
              toKeyPair: { address },
              payload: attestationPayload,
          });

          if (res.data) {
              this.attestationService.setPendingAtt(address);
              this.toastrService.success(res.data, 'Transaction Sent');
          }
      } catch (error) {
          this.toastrService.error(error.message, 'Attestation Error');
      } finally {
          this.loadingService.isLoading = false;
      }
  }


private async ensurePropertyType(pid: number): Promise<number | undefined> {
  if (this.propertyTypeCache.has(pid)) return this.propertyTypeCache.get(pid)!;
  // backend expects: POST /tl_getProperty with { params: pid }
  const data: any = await this.http.post('http://localhost:3000/tl_getProperty', { params: pid }).toPromise();
  // expect data.type present; synthetic == 5
  const t = Number(data?.type);
  if (!Number.isFinite(t)) return undefined;
  this.propertyTypeCache.set(pid, t);
  return t;
}

// --- label for the button in the table ---
getMintRedeemLabel(row: any): string {
  const t = this.propertyTypeCache.get(Number(row?.propertyid));
  // If we don't know yet, default to 'Mint' and we’ll update on click
  return t === 5 ? 'Redeem' : 'Mint';
}

}