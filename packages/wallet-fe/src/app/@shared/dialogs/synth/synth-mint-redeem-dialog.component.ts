// src/app/@shared/dialogs/synth/synth-mint-redeem-dialog.component.ts
import { Component, Inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { HttpClient } from '@angular/common/http';
import { ToastrService } from 'ngx-toastr';
import { IBuildTxConfig, TxsService } from 'src/app/@core/services/txs.service'; import { ENCODER } from 'src/app/utils/payloads/encoder';

export type SynthMode = 'mint' | 'redeem';

type ContractRow = { 
    id: number; 
    label: string; 
    notional?: number; 
    maxMintLTC?: number
    maxMintUnits?: number; };

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

  constructor(
    public dialogRef: MatDialogRef<SynthMintRedeemDialogComponent>,
    @Inject(MAT_DIALOG_DATA) public data: {
      mode?: SynthMode;                 // now optional — we’ll infer if not provided
      address: string;
      propId: number | string;      // may be 's<pid>-<cid>' alias or a number
      available?: number
    },
    private txsService: TxsService,
    private toastr: ToastrService,
    private http: HttpClient
  ) {}

  async ngOnInit() {
    // 1) Infer mode from propId if not explicitly provided:
    if (!this.data.mode) {
      const isSynthAlias = typeof this.data.propId === 'string' && /^s\d+-\d+$/i.test(this.data.propId);
      this.data.mode = isSynthAlias ? 'redeem' : 'mint';
    }

    // 2) Load caps
    if (this.data.mode === 'mint') {
      await this.loadEligibility(); // fills contracts & default selection & cap
    } else {
      await this.loadRedeemCap();   // simple available balance
    }
  }

  get selectedContract() {
    return this.contracts.find(c => c.id === this.selectedContractId) || null;
  }

  get maxMintUnits() {
    return this.selectedContract?.maxMintUnits ?? 0;
  }

  setMaxAmount() {
    if (this.maxMintUnits > 0) {
      this.amount = String(this.maxMintUnits);
    }
  }


  private async loadEligibility() {
    console.log('data inject in synth '+JSON.stringify(this.data))
    //try {

      const resp: any = await this.http.get(`http://localhost:3000/tl_getMaxSynth`, {
        params: { address: this.data.address, propId: this.data.propId },
      }).toPromise();
      console.log('loadEligibility response', resp);

      // Normalize to dialog shape
      this.contracts = (resp?.eligible || []).map((c: any) => ({
        id: Number(c.contractId),
        label: c.symbol || `Contract #${c.contractId}`,
        seriesId: c.seriesId,
        notionalPropertyId: c.notionalPropertyId,
        perContractUnits: c.perContractUnits,
        maxMintUnits: c.maxMintUnits,
      }));


      // pick the first eligible by default
      this.selectedContractId = this.contracts[0]?.id ?? null;

      // cap = selected contract max (fallback to total)
      const selected = this.contracts.find(c => c.id === this.selectedContractId);
      const max = selected?.maxMintLTC ?? Number(resp?.maxMintTotalLTC ?? 0);
      if (max > 0) {
        this.capInfo = { max };
        this.amount = max.toFixed(8);
      } else {
        this.capInfo = undefined;
      }
    //} catch {
      //this.contracts = [];
      //this.selectedContractId = null;
      //this.capInfo = undefined;
    //}
  }

  private async loadRedeemCap() {
    try{
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
    const selected = this.contracts.find(c => c.id === id);
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
    try { navigator.clipboard?.writeText(this.data.address); } catch {}
  }

  onSlide(ev: any) {
    if (!this.capInfo) return;
    const v = (ev?.value ?? ev?.target?.value ?? 0) as number;
    const pct = Math.max(0, Math.min(100, Number(v) || 0)) / 100;
    this.amount = (this.capInfo.max * pct).toFixed(8);
  }

  cancel() { this.dialogRef.close(); }

   async submit() {
    try {
      let payload: string;

      if (this.data.mode === 'mint') {
        payload = ENCODER.encodeMintSynthetic({
          propertyId: Number(this.data.propId),
          contractId: Number(this.selectedContractId),
          amount: Number(this.amount)
        });
      } else {
        payload = ENCODER.encodeRedeemSynthetic({
          propertyId: String(this.data.propId),   // redeem expects composite key
          contractId: Number(this.selectedContractId),
          amount: Number(this.amount)
        });
      }

      const cfg: IBuildTxConfig = {
        fromKeyPair: { address: this.data.address },
        toKeyPair:   { address: this.data.address }, // loopback, since payload is the point
        amount: 0,                                   // no LTC amount, just the payload
        payload
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
