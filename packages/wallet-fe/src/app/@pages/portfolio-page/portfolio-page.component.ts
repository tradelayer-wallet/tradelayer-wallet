import { Component, ElementRef, OnInit, ChangeDetectorRef } from '@angular/core';
import { ToastrService } from 'ngx-toastr';
import { AttestationService } from 'src/app/@core/services/attestation.service';
import { AuthService } from 'src/app/@core/services/auth.service';
import { ApiService } from 'src/app/@core/services/api.service';
import { BalanceService } from 'src/app/@core/services/balance.service';
import { DialogService, DialogTypes } from 'src/app/@core/services/dialogs.service';
import { LoadingService } from 'src/app/@core/services/loading.service';
import { RpcService } from 'src/app/@core/services/rpc.service';
import { TxsService } from 'src/app/@core/services/txs.service';
import { ENCODER } from 'src/app/utils/payloads/encoder';
import { HttpClient } from '@angular/common/http';
import { MatDialog } from '@angular/material/dialog';
import {
  M1_RECEIPT_PROPERTY_ID,
  M1_RECEIPT_TICKER,
} from 'src/app/@core/constants/procedural.constants';

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
  receiptPropertyId: number | null = null;

  constructor(
    private apiService: ApiService,
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
    private http: HttpClient,
  ) {}

  get tlApi() {
    return this.apiService.newTlApi;
  }

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

  get nativeAssetLabel() {
    return this.rpcService.NETWORK === 'BTC' ? 'tBTC' : 'tLTC';
  }

  get isLtctest() {
    return this.rpcService.NETWORK === 'LTCTEST';
  }

  get underlyingAssetLabel() {
    return this.rpcService.NETWORK === 'BTC' ? 'BTC' : 'LTC';
  }

 ngOnInit(): void {
    this.authService.getAddressesFromWallet().then(() => {
        this.walletAddresses = this.authService.walletAddresses; // Ensure this happens after addresses are fetched
        this.startAttestationUpdateInterval();
        this.loadReceiptPropertyId();
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

  isSyntheticRow(row: any): boolean {
    return String(row?.rawPropertyId || '').startsWith('s');
  }

  isProceduralReceiptRow(row: any): boolean {
    return this.isLtctest && Number(row?.propertyid) === Number(this.receiptPropertyId || 0);
  }

  getMintRedeemLabel(row: any): string {
    if (this.isProceduralReceiptRow(row) || this.isSyntheticRow(row)) {
      return `Redeem ${this.underlyingAssetLabel}`;
    }
    return 'Mint';
  }


  openDialog(dialog: string, address?: any, _propId?: number | string, _amount?: number, extraData: any = {}) {
    const data = { address, propId: _propId, amount: _amount, available: _amount, ...extraData };

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

  openTokenizeDialog(address: string, amount?: number) {
    this.openDialog('synth', address, 1, amount, {
      mode: 'mint',
      flow: this.isLtctest ? 'proceduralReceipt' : 'synthetic',
      title: `Tokenize ${this.nativeAssetLabel}`,
      actionLabel: 'Tokenize',
      underlyingAssetLabel: this.underlyingAssetLabel,
    });
  }

  openTokenActionDialog(address: string, row: any) {
    const isSynthetic = this.isSyntheticRow(row);
    const isProceduralReceipt = this.isProceduralReceiptRow(row);
    const isRedeem = isSynthetic || isProceduralReceipt;
    this.openDialog('synth', address, row.rawPropertyId || row.propertyid, row.available, {
      mode: isRedeem ? 'redeem' : 'mint',
      flow: isProceduralReceipt ? 'proceduralReceipt' : 'synthetic',
      title: isRedeem ? `Redeem ${this.underlyingAssetLabel}` : `Mint ${this.nativeAssetLabel}`,
      actionLabel: isRedeem ? `Redeem ${this.underlyingAssetLabel}` : 'Mint',
      underlyingAssetLabel: this.underlyingAssetLabel,
    });
  }

  async loadReceiptPropertyId() {
    if (!this.isLtctest) {
      this.receiptPropertyId = null;
      return;
    }

    if (Number.isFinite(M1_RECEIPT_PROPERTY_ID) && M1_RECEIPT_PROPERTY_ID > 0) {
      this.receiptPropertyId = Number(M1_RECEIPT_PROPERTY_ID);
      return;
    }

    try {
      const propertiesRes = await this.tlApi.rpc('listProperties').toPromise();
      const properties = Array.isArray(propertiesRes?.data) ? propertiesRes.data : [];
      const match = properties.find((property: any) => {
        return String(property?.ticker || '').toUpperCase() === M1_RECEIPT_TICKER.toUpperCase();
      });

      if (match?.id != null) {
        this.receiptPropertyId = Number(match.id);
        return;
      }

      this.receiptPropertyId = null;
    } catch (error) {
      console.error('Error resolving procedural receipt property id:', error);
      this.receiptPropertyId = null;
    }
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
      } catch (error: any) {
          this.toastrService.error(error.message, 'Attestation Error');
      } finally {
          this.loadingService.isLoading = false;
      }
  }

}
