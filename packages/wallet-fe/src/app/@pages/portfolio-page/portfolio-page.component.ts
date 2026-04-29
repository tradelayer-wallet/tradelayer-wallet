import { Component, ElementRef, OnInit, ChangeDetectorRef } from '@angular/core';
import { OnDestroy } from '@angular/core';
import { ToastrService } from 'ngx-toastr';
import { AttestationService } from 'src/app/@core/services/attestation.service';
import { AuthService } from 'src/app/@core/services/auth.service';
import { ApiService } from 'src/app/@core/services/api.service';
import { BalanceService } from 'src/app/@core/services/balance.service';
import { DialogService, DialogTypes } from 'src/app/@core/services/dialogs.service';
import { RpcService } from 'src/app/@core/services/rpc.service';
import { TxsService } from 'src/app/@core/services/txs.service';
import { ENCODER } from 'src/app/utils/payloads/encoder';
import { HttpClient } from '@angular/common/http';
import { MatDialog } from '@angular/material/dialog';
import {
  M1_RECEIPT_PROPERTY_ID,
  M1_RECEIPT_TICKER,
} from 'src/app/@core/constants/procedural.constants';

interface ProceduralReceiptRow {
  contractId: string;
  templateId: string;
  dlcHash: string;
  state: string;
  redeemAddress: string;
  fundingTxid: string;
  fundedAmount: number;
  fundedAt: number | null;
  fundingPropertyId: number | null;
  currentBlock: number;
  windowBlocks: number;
  remainingBlocks: number | null;
  canRedeem: boolean;
}

@Component({
  selector: 'tl-portoflio-page',
  templateUrl: './portfolio-page.component.html',
  styleUrls: ['./portfolio-page.component.scss']
})
export class PortfolioPageComponent implements OnInit, OnDestroy {
  walletAddresses: string[] = []; 
  cryptoBalanceColumns: string[] = ['attestation', 'address', 'confirmed', 'unconfirmed', 'tokens', 'actions'];
  tokensBalanceColums: string[] = ['propertyid', 'name', 'available', 'reserved', 'margin', 'channel', 'receiptState', 'blocksRemaining', 'actions'];
  selectedAddress: string = '';
  hideZeroBalances: boolean = false;
  receiptPropertyId: number | null = null;
  proceduralReceipts: ProceduralReceiptRow[] = [];
  private proceduralReceiptRefreshId: ReturnType<typeof setInterval> | null = null;
  private attestingAddresses = new Set<string>();
  private attestationStatusByAddress = new Map<string, string | boolean>();

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
    private cdr: ChangeDetectorRef, // Inject ChangeDetectorRef,
    private http: HttpClient,
  ) {}

  get tlApi() {
    return this.apiService.newTlApi;
  }

  get coinBalance() {
    return this.authService.walletAddresses
      .map((address, index) => {
        const coinBalance = this.balanceService.getCoinBalancesByAddress(address) || {};
        const hasNativeBalance = this.hasNativeBalance(coinBalance);
        const hasTokenBalance = this.hasTokenBalance(address);
        return {
          address,
          index,
          hasAnyBalance: hasNativeBalance || hasTokenBalance,
          tokenSummary: this.getTokenSummaryForAddress(address),
          ...coinBalance,
        };
      })
      .filter((row) => !this.hideZeroBalances || row.hasAnyBalance)
      .sort((a, b) => {
        const aConfirmed = Number(a.confirmed || 0);
        const bConfirmed = Number(b.confirmed || 0);
        const aUnconfirmed = Number(a.unconfirmed || 0);
        const bUnconfirmed = Number(b.unconfirmed || 0);

        if (a.hasAnyBalance !== b.hasAnyBalance) {
          return a.hasAnyBalance ? -1 : 1;
        }

        if (aConfirmed !== bConfirmed) {
          return bConfirmed - aConfirmed;
        }

        if (aUnconfirmed !== bUnconfirmed) {
          return bUnconfirmed - aUnconfirmed;
        }

        return a.index - b.index;
      })
      .map(({ index, hasAnyBalance, ...balanceRow }) => balanceRow);
  }

  get tokensBalances() {
    const balances = this.balanceService.getTokensBalancesByAddress(this.selectedAddress);
    return balances.map((row: any) => {
      const procedural = this.getProceduralReceiptForRow(row);
      return {
        ...row,
        receiptState: procedural?.state || (this.isProceduralReceiptRow(row) ? 'UNFUNDED' : '-'),
        blocksRemaining: procedural?.remainingBlocks ?? null,
        canRedeem: procedural?.canRedeem ?? false,
        fundingTxid: procedural?.fundingTxid || '',
        contractId: procedural?.contractId || '',
      };
    });
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

  private hasNativeBalance(balance: any): boolean {
    const confirmed = Number(balance?.confirmed || 0);
    const unconfirmed = Number(balance?.unconfirmed || 0);
    return confirmed > 0 || unconfirmed > 0;
  }

  private hasTokenBalance(address: string): boolean {
    const balances = this.balanceService.getTokensBalancesByAddress(address) || [];
    return balances.some((row: any) => {
      return ['amount', 'available', 'reserved', 'margin', 'vesting', 'channel']
        .some((field) => Math.abs(Number(row?.[field] || 0)) > 0);
    });
  }

  getTokenSummaryForAddress(address: string): string {
    const balances = this.balanceService.getTokensBalancesByAddress(address) || [];
    const nonZeroBalances = balances
      .map((row: any) => {
        const total = ['available', 'reserved', 'margin', 'vesting', 'channel']
          .reduce((sum, field) => sum + Number(row?.[field] || 0), 0);
        return {
          label: row?.name || row?.ticker || row?.rawPropertyId || row?.propertyid || 'Token',
          total,
        };
      })
      .filter((row) => Math.abs(row.total) > 0);

    if (!nonZeroBalances.length) return '-';

    return nonZeroBalances
      .slice(0, 3)
      .map((row) => `${row.label}: ${Number(row.total.toFixed(6))}`)
      .join(', ');
  }

ngOnInit(): void {
    this.authService.getAddressesFromWallet().then(() => {
        this.walletAddresses = this.authService.walletAddresses; // Ensure this happens after addresses are fetched
        this.updateCachedAttestationStatuses();
        this.attestationService.refreshAttestations(this.walletAddresses).finally(() => {
          this.updateCachedAttestationStatuses();
          this.cdr.detectChanges();
        });
        this.loadReceiptPropertyId();
    }).catch(error => {
        console.error('Error fetching wallet addresses:', error);
    });
}


  ngOnDestroy(): void {
    if (this.proceduralReceiptRefreshId) {
      clearInterval(this.proceduralReceiptRefreshId);
      this.proceduralReceiptRefreshId = null;
    }
  }

  // Fetch and update attestation statuses for all wallet addresses
  async updateAttestationStatuses() {
    await this.attestationService.refreshAttestations(this.authService.listOfallAddresses);
    this.updateCachedAttestationStatuses();
  }

  getAddressAttestationStatus(address: string): string | boolean {
      const attestation = this.attestationStatusByAddress.get(address);

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

  private setCachedAttestationStatus(address: string, status: string | boolean) {
    this.attestationStatusByAddress.set(address, status);
  }

  private updateCachedAttestationStatuses() {
    const addresses = this.authService.listOfallAddresses || [];
    addresses.forEach((address) => {
      this.setCachedAttestationStatus(address, this.attestationService.getAttByAddress(address));
    });
  }

  isAttestingAddress(address: string): boolean {
    return this.attestingAddresses.has(address);
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
    const rid = Number(this.receiptPropertyId || 0);
    return this.isLtctest && rid > 0 && Number(row?.propertyid) === rid;
  }

  getProceduralReceiptForRow(row: any): ProceduralReceiptRow | null {
    const rid = Number(row?.propertyid || row?.rawPropertyId || 0);
    if (!rid) return null;
    const match = this.proceduralReceipts.find((receipt) => {
      const propertyId = Number(receipt?.fundingPropertyId || 0);
      return propertyId === rid || (rid === Number(this.receiptPropertyId || 0) && !!receipt?.state);
    });
    return match || null;
  }

  canRedeemProceduralRow(row: any): boolean {
    const procedural = this.getProceduralReceiptForRow(row);
    if (!procedural) return true;
    return Boolean(procedural.canRedeem);
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
      flow: this.isLtctest ? 'bitvmDlc' : 'synthetic',
      title: this.isLtctest ? 'Peg Into BitVM DLC' : `Tokenize ${this.nativeAssetLabel}`,
      actionLabel: this.isLtctest ? 'Peg In' : 'Tokenize',
      underlyingAssetLabel: this.underlyingAssetLabel,
    });
  }

  openTokenActionDialog(address: string, row: any) {
    const isSynthetic = this.isSyntheticRow(row);
    const isProceduralReceipt = this.isProceduralReceiptRow(row);
    const isRedeem = isSynthetic || isProceduralReceipt;
    this.openDialog('synth', address, row.rawPropertyId || row.propertyid, row.available, {
      mode: isRedeem ? 'redeem' : 'mint',
      flow: isProceduralReceipt ? 'bitvmDlc' : 'synthetic',
      title: isProceduralReceipt ? `Redeem BitVM DLC` : (isRedeem ? `Redeem ${this.underlyingAssetLabel}` : `Mint ${this.nativeAssetLabel}`),
      actionLabel: isProceduralReceipt ? 'Redeem' : (isRedeem ? `Redeem ${this.underlyingAssetLabel}` : 'Mint'),
      underlyingAssetLabel: this.underlyingAssetLabel,
    });
  }

  async loadReceiptPropertyId() {
    if (!this.isLtctest) {
      this.receiptPropertyId = null;
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

      if (Number.isFinite(M1_RECEIPT_PROPERTY_ID) && M1_RECEIPT_PROPERTY_ID > 0) {
        this.receiptPropertyId = Number(M1_RECEIPT_PROPERTY_ID);
        return;
      }

      this.receiptPropertyId = null;
    } catch (error) {
      console.error('Error resolving procedural receipt property id:', error);
      if (Number.isFinite(M1_RECEIPT_PROPERTY_ID) && M1_RECEIPT_PROPERTY_ID > 0) {
        this.receiptPropertyId = Number(M1_RECEIPT_PROPERTY_ID);
        return;
      }

      this.receiptPropertyId = null;
    }
  }

  async loadProceduralReceipts(address: string) {
    if (!this.isLtctest || !address) {
      this.proceduralReceipts = [];
      return;
    }

    try {
      const res = await this.tlApi.rpc('getProceduralReceiptsForAddress', [address]).toPromise();
      const receipts = Array.isArray(res?.data) ? res.data : [];
      this.proceduralReceipts = receipts.map((receipt: any) => ({
        contractId: String(receipt?.contractId || ''),
        templateId: String(receipt?.templateId || ''),
        dlcHash: String(receipt?.dlcHash || ''),
        state: String(receipt?.state || '').toUpperCase(),
        redeemAddress: String(receipt?.redeemAddress || ''),
        fundingTxid: String(receipt?.fundingTxid || ''),
        fundedAmount: Number(receipt?.fundedAmount || 0),
        fundedAt: receipt?.fundedAt != null ? Number(receipt.fundedAt) : null,
        fundingPropertyId: receipt?.fundingPropertyId != null ? Number(receipt.fundingPropertyId) : null,
        currentBlock: Number(receipt?.currentBlock || 0),
        windowBlocks: Number(receipt?.windowBlocks || 0),
        remainingBlocks: receipt?.remainingBlocks != null ? Number(receipt.remainingBlocks) : null,
        canRedeem: Boolean(receipt?.canRedeem),
      }));
    } catch (error) {
      console.error('Error fetching procedural receipts:', error);
      this.proceduralReceipts = [];
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


  async showTokens(address: string) {
    this.selectedAddress = address;
    await this.loadProceduralReceipts(address);
    if (this.proceduralReceiptRefreshId) {
      clearInterval(this.proceduralReceiptRefreshId);
    }
    this.proceduralReceiptRefreshId = setInterval(() => {
      if (this.selectedAddress) {
        this.loadProceduralReceipts(this.selectedAddress);
      }
    }, 15000);
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
      if (this.attestingAddresses.has(address)) return;
      try {
          this.attestingAddresses.add(address);
          this.setCachedAttestationStatus(address, 'PENDING');
          this.cdr.detectChanges();
          //const ipToCheck = await this.rpcService.rpc('tl_getIpByAddress', [address]);
          const ipCheckResult = await this.attestationService.checkIP();
          if (!ipCheckResult?.success) {
            throw new Error(ipCheckResult?.error || 'Unable to complete IP attestation check.');
          }

          const countryCode = String(
            ipCheckResult?.attestation?.country || ipCheckResult?.attestation?.countryCode || 'UNKNOWN'
          ).toUpperCase();

          const bannedCountries = ["US", "KP", "SY", "SD", "RU", "IR"];
          
          if (bannedCountries.includes(countryCode)) {
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
              suppressGlobalLoading: true,
          });

          if (res.data) {
              this.attestationService.setPendingAtt(address);
              this.setCachedAttestationStatus(address, 'PENDING');
              this.toastrService.success(res.data, 'Transaction Sent');
          } else {
              this.updateCachedAttestationStatuses();
              this.toastrService.error(res.error || 'Failed to send attestation transaction.', 'Attestation Error');
          }
      } catch (error: any) {
          this.updateCachedAttestationStatuses();
          this.toastrService.error(error.message, 'Attestation Error');
      } finally {
          this.attestingAddresses.delete(address);
          this.cdr.detectChanges();
      }
  }

}
