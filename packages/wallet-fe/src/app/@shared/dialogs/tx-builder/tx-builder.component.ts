import { Component, Inject, Input } from '@angular/core';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { LoadingService } from 'src/app/@core/services/loading.service';

@Component({
  selector: 'tx-builder-dialog',
  templateUrl: './tx-builder.component.html',
  styleUrls: ['./tx-builder.component.scss']
})

export class TxBuilderDialog {
    constructor(
        @Inject(MAT_DIALOG_DATA) private data: any,
        public dialogRef: MatDialogRef<TxBuilderDialog>,
        private loadingService: LoadingService,
    ) { }

    close() {
        this.dialogRef.close();
    }

    setLoading(loading: boolean) {
        this.loadingService.isLoading = loading;
    }
}
