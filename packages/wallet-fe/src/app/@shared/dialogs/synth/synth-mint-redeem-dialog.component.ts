// src/app/@shared/dialogs/synth/synth-mint-redeem-dialog.component.ts
import { Component, Inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { HttpClient } from '@angular/common/http';
import { ToastrService } from 'ngx-toastr';
import { ApiService } from 'src/app/@core/services/api.service';
import { IBuildTxConfig, TxsService } from 'src/app/@core/services/txs.service';
import { ENCODER } from 'src/app/utils/payloads/encoder';
import {
  M1_PROCEDURAL_RECEIPT_CONFIG,
  ProceduralReceiptConfig,
} from 'src/app/@core/constants/procedural.constants';

export type SynthMode = 'mint' | 'redeem';
export type SynthFlow = 'synthetic' | 'proceduralReceipt';

type ContractRow = {
  id: number;
  label: string;
  notional?: number;
  maxMintLTC?: number;
  maxMintUnits?: number;
};

@Component({
  selector: 'app-synth-mint-redeem-dialog',
  templateUrl: './synth-mint-redeem-dialog.component.html',
  styleUrls: ['./synth.scss'],
})
export class SynthMintRedeemDialogComponent {
  amount = '';
  capInfo?: { max: number };
  contracts: ContractRow[] = [];
  selectedContractId: number | null = null;
  proceduralConfig?: ProceduralReceiptConfig;

  constructor(
    public dialogRef: MatDialogRef<SynthMintRedeemDialogComponent>,
    @Inject(MAT_DIALOG_DATA)
    public data: {
      mode?: SynthMode;
      flow?: SynthFlow;
      address: string;
      propId: number | string;
      available?: number;
      title?: string;
      actionLabel?: string;
      underlyingAssetLabel?: string;
    },
    private txsService: TxsService,
    private toastr: ToastrService,
    private http: HttpClient,
    private apiService: ApiService
  ) {}

  get tlApi() {
    return this.apiService.newTlApi;
  }

  get isProceduralFlow() {
    return this.data.flow === 'proceduralReceipt';
  }

  async ngOnInit() {
    if (!this.data.mode) {
      const isSynthAlias =
        typeof this.data.propId === 'string' && /^s\d+-\d+$/i.test(this.data.propId);
      this.data.mode = isSynthAlias ? 'redeem' : 'mint';
    }
    if (!this.data.underlyingAssetLabel) {
      this.data.underlyingAssetLabel = 'LTC';
    }
    if (!this.data.flow) {
      this.data.flow = 'synthetic';
    }

    if (this.isProceduralFlow) {
      await this.loadProceduralConfig();
      await this.loadAmountCap();
      return;
    }

    if (this.data.mode === 'mint') {
      await this.loadEligibility();
    } else {
      await this.loadRedeemCap();
    }
  }

  get selectedContract() {
    return this.contracts.find((c) => c.id === this.selectedContractId) || null;
  }

  get titleText() {
    if (this.data.title) return this.data.title;
    return this.data.mode === 'mint'
      ? 'Mint Synthetic'
      : `Redeem ${this.data.underlyingAssetLabel || 'LTC'}`;
  }

  get submitText() {
    if (this.data.actionLabel) return this.data.actionLabel;
    return this.data.mode === 'mint' ? 'Mint' : `Redeem ${this.data.underlyingAssetLabel || 'LTC'}`;
  }

  get maxMintUnits() {
    return this.selectedContract?.maxMintUnits ?? 0;
  }

  setMaxAmount() {
    if (this.maxMintUnits > 0) {
      this.amount = String(this.maxMintUnits);
    }
  }

  private async loadProceduralConfig() {
    this.proceduralConfig = {
      ...M1_PROCEDURAL_RECEIPT_CONFIG,
    };
  }

  private async resolveReceiptPropertyId(): Promise<number | undefined> {
    const configuredReceiptPropertyId = Number(M1_PROCEDURAL_RECEIPT_CONFIG.receiptPropertyId || 0);
    if (Number.isFinite(configuredReceiptPropertyId) && configuredReceiptPropertyId > 0) {
      return configuredReceiptPropertyId;
    }

    const propId = Number(this.data.propId);
    if (this.data.mode === 'redeem' && Number.isFinite(propId) && propId > 0) {
      return propId;
    }

    const propertiesRes = await this.tlApi.rpc('listProperties').toPromise();
    const properties = Array.isArray(propertiesRes?.data) ? propertiesRes.data : [];
    const ticker = String(M1_PROCEDURAL_RECEIPT_CONFIG.receiptTicker || '').toUpperCase();
    const tickerMatch = properties.find((property: any) => String(property?.ticker || '').toUpperCase() === ticker);
    if (tickerMatch?.id != null) {
      return Number(tickerMatch.id);
    }

    return undefined;
  }

  private async loadAmountCap() {
    const max = Number(this.data.available ?? 0);
    if (max > 0) {
      this.capInfo = { max };
      this.amount = max.toFixed(8);
    } else {
      this.capInfo = undefined;
    }
  }

  private async loadEligibility() {
    const resp: any = await this.http
      .get(`http://localhost:3000/tl_getMaxSynth`, {
        params: { address: this.data.address, propId: this.data.propId },
      })
      .toPromise();

    this.contracts = (resp?.eligible || []).map((c: any) => ({
      id: Number(c.contractId),
      label: c.symbol || `Contract #${c.contractId}`,
      seriesId: c.seriesId,
      notionalPropertyId: c.notionalPropertyId,
      perContractUnits: c.perContractUnits,
      maxMintUnits: c.maxMintUnits,
    }));

    this.selectedContractId = this.contracts[0]?.id ?? null;

    const selected = this.contracts.find((c) => c.id === this.selectedContractId);
    const max = selected?.maxMintLTC ?? Number(resp?.maxMintTotalLTC ?? 0);
    if (max > 0) {
      this.capInfo = { max };
      this.amount = max.toFixed(8);
    } else {
      this.capInfo = undefined;
    }
  }

  private async loadRedeemCap() {
    try {
      const max = Number(this.data.available ?? 0);
      if (max > 0) {
        this.capInfo = { max };
        this.amount = max.toFixed(8);
      } else {
        this.capInfo = undefined;
      }
    } catch {
      this.capInfo = undefined;
    }
  }

  onContractChange(id: number) {
    this.selectedContractId = id;
    const selected = this.contracts.find((c) => c.id === id);
    const max = selected?.maxMintLTC ?? 0;
    this.capInfo = max > 0 ? { max } : undefined;
    if (max > 0) this.amount = max.toFixed(8);
  }

  fillMax() {
    if (this.capInfo) this.amount = this.capInfo.max.toFixed(8);
  }

  isPositive(val: string) {
    const n = Number(val);
    return Number.isFinite(n) && n > 0;
  }

  copyAddress() {
    try {
      navigator.clipboard?.writeText(this.data.address);
    } catch {}
  }

  onSlide(ev: any) {
    if (!this.capInfo) return;
    const v = (ev?.value ?? ev?.target?.value ?? 0) as number;
    const pct = Math.max(0, Math.min(100, Number(v) || 0)) / 100;
    this.amount = (this.capInfo.max * pct).toFixed(8);
  }

  cancel() {
    this.dialogRef.close();
  }

  private async submitProceduralReceipt() {
    if (!this.proceduralConfig?.receiptPropertyId) {
      throw new Error('Receipt property could not be resolved.');
    }

    if (this.data.mode === 'mint') {
      const result = await this.txsService.tokenizeProceduralReceipt({
        depositorAddress: this.data.address,
        amount: Number(this.amount),
        config: this.proceduralConfig,
      });

      if (result.error || !result.data) {
        throw new Error(result.error || 'Tokenize failed');
      }

      this.toastr.success(`Deposit TX: ${result.data.depositTxid}`);
      this.toastr.success(`Mint TX: ${result.data.mintTxid}`);
      this.dialogRef.close(result);
      return;
    }

    const result = await this.txsService.redeemProceduralReceiptWithRelease({
      holderAddress: this.data.address,
      amount: Number(this.amount),
      config: this.proceduralConfig,
    });

    if (result.error || !result.data) {
      throw new Error(result.error || 'Redeem failed');
    }

    this.toastr.success(`Redeem TX: ${result.data.redeemTxid}`);
    this.toastr.success(`Release TX: ${result.data.releaseTxid}`);
    this.dialogRef.close(result);
  }

  async submit() {
    try {
      if (this.isProceduralFlow) {
        await this.submitProceduralReceipt();
        return;
      }

      let payload: string;

      if (this.data.mode === 'mint') {
        payload = ENCODER.encodeMintSynthetic({
          propertyId: Number(this.data.propId),
          contractId: Number(this.selectedContractId),
          amount: Number(this.amount),
        });
      } else {
        payload = ENCODER.encodeRedeemSynthetic({
          propertyId: String(this.data.propId),
          contractId: Number(this.selectedContractId),
          amount: Number(this.amount),
        });
      }

      const cfg: IBuildTxConfig = {
        fromKeyPair: { address: this.data.address },
        toKeyPair: { address: this.data.address },
        amount: 0,
        payload,
      };

      const result = await this.txsService.buildSingSendTx(cfg);
      this.toastr.success(`Tx sent: ${result.data}`);
      this.dialogRef.close(result);
    } catch (err: any) {
      console.error('[SynthDialog] tx error', err);
      this.toastr.error(err.message || 'Tx failed');
    }
  }
}
