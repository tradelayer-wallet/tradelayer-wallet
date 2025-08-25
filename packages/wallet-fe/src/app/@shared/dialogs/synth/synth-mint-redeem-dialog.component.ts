import { Component, Inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { HttpClient } from '@angular/common/http';

export type SynthMode = 'mint' | 'redeem';

type ContractOption = { id: number; label: string; notional?: number };

@Component({                 
  selector: 'app-synth-mint-redeem-dialog',
  templateUrl: './synth-mint-redeem-dialog.component.html',
  styleUrls: ['./synth.scss']
})
export class SynthMintRedeemDialogComponent {
  amount = '';
  capInfo?: { max: number };

contracts: ContractOption[] = [];
selectedContractId: number | null = null;

  constructor(
    public dialogRef: MatDialogRef<SynthMintRedeemDialogComponent>,
    @Inject(MAT_DIALOG_DATA) public data: {
      mode: SynthMode;
      address: string;
      propertyId: number;
      // optional: contractIdUsed, etc.
    },
    private http: HttpClient,
  ) {}

  async // NEW: load eligible contracts for this property
private async loadContracts() {
  try {
    // Option A: via your markets service REST (replace with your real endpoint)
    // Expecting [{ id, symbol, type, basePid, notional }, ...]
    const markets: any[] = await this.http
      .get<any[]>('/api/markets')
      .toPromise();

    // Filter to inverse-native contracts for this property
    const pid = this.data.propertyId;
    const eligible = (markets || []).filter(m =>
      (m?.type === 'inverse_native' || m?.isInverseNative === true) &&
      (m?.basePid === pid || m?.propertyId === pid || m?.underlyingPid === pid)
    );

    this.contracts = eligible.map(m => ({
      id: Number(m.contractId ?? m.id),
      label: `${m.symbol ?? 'TL/??'} · inverse native${m?.notional ? ' · N=' + m.notional : ''}`,
      notional: m.notional
    }));

    if (this.contracts.length) {
      this.selectedContractId = this.contracts[0].id;
    }
  } catch {
    this.contracts = [];
    this.selectedContractId = null;
  }
}

// handle selection change from dropdown
onContractChange(contractId: number) {
  this.selectedContractId = contractId;
  // if Mint, re-calc cap for the newly selected hedge
  if (this.data.mode === 'mint') this.loadCap();
}

// factor out cap loading so we can call it on init and on change
private async loadCap() {
  try {
    if (this.data.mode === 'mint') {
      const cap: any = await this.http.get(`/api/portfolio/mint-cap`, {
        params: {
          address: this.data.address,
          propertyId: this.data.propertyId,
          contractId: String(this.selectedContractId ?? '')
        } as any,
      }).toPromise();
      const max = Number(cap?.maxMint ?? 0);
      this.capInfo = max > 0 ? { max } : undefined;
      if (max > 0) this.amount = max.toFixed(8);
    } else {
      const cap: any = await this.http.get(`/api/portfolio/synth-available`, {
        params: { address: this.data.address, propertyId: this.data.propertyId } as any,
      }).toPromise();
      const max = Number(cap?.available ?? 0);
      this.capInfo = max > 0 ? { max } : undefined;
      if (max > 0) this.amount = max.toFixed(8);
    }
  } catch {
    this.capInfo = undefined;
  }
}

// update your existing ngOnInit to call loadContracts() first (for Mint), then loadCap()
async ngOnInit() {
 const isSynthAlias = typeof this.data.propertyId === 'string' && /^s\d+-\d+$/i.test(this.data.propertyId);
      this.data.mode = isSynthAlias ? 'redeem' : 'mint';
  try {
    if (this.data.mode === 'mint') {
      await this.loadContracts();  // populate dropdown + default selection
    }
    await this.loadCap();          // compute cap (uses selectedContractId on Mint)
  } catch {}
}

// small helpers already added in previous step (keep them)
// fillMax(), copyAddress(), onSlide(), isPositive() ...

// include contractIdUsed on submit (for Mint)
submit() {
  this.dialogRef.close({
    amount: this.amount,
    propertyIdUsed: this.data.propertyId,
    contractIdUsed: this.data.mode === 'mint' ? this.selectedContractId : undefined,
    mode: this.data.mode,
    address: this.data.address,
  });
}
  fillMax() {
    if (this.capInfo) this.amount = this.capInfo.max.toFixed(8);
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

isPositive(val: string) {
  const n = Number(val);
  return Number.isFinite(n) && n > 0;
}

  cancel() { this.dialogRef.close(); }

  submit() {
    this.dialogRef.close({
      amount: this.amount,
      propertyIdUsed: this.data.propertyId,
      // contractIdUsed: 2001, // if you want to pass it
    });
  }
}
