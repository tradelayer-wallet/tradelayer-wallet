import { Component, Inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { HttpClient } from '@angular/common/http';

export type SynthMode = 'mint' | 'redeem';

@Component({
  selector: 'app-synth-mint-redeem-dialog',
  templateUrl: './synth-mint-redeem-dialog.component.html',
  styleUrls: ['./synth-mint-redeem-dialog.component.scss'],
})
export class SynthMintRedeemDialogComponent {
  amount = '';
  capInfo?: { max: number };

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

  async ngOnInit() {
    try {
      if (this.data.mode === 'mint') {
        const cap: any = await this.http.get(`/api/portfolio/mint-cap`, {
          params: { address: this.data.address, propertyId: this.data.propertyId } as any,
        }).toPromise();
        const max = Number(cap?.maxMint ?? 0);
        if (max > 0) {
          this.capInfo = { max };
          this.amount = max.toFixed(8);
        }
      } else {
        const cap: any = await this.http.get(`/api/portfolio/synth-available`, {
          params: { address: this.data.address, propertyId: this.data.propertyId } as any,
        }).toPromise();
        const max = Number(cap?.available ?? 0);
        if (max > 0) {
          this.capInfo = { max };
          this.amount = max.toFixed(8);
        }
      }
    } catch {}
  }

  fillMax() {
    if (this.capInfo) this.amount = this.capInfo.max.toFixed(8);
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
