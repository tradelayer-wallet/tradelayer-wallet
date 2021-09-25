import { Component, Inject } from '@angular/core';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { ToastrService } from 'ngx-toastr';

@Component({
  selector: 'deposit-dialog',
  templateUrl: './deposit.component.html',
  styleUrls: ['./deposit.component.scss']
})
export class DepositDialog {
    constructor(
        public dialogRef: MatDialogRef<DepositDialog>,
        @Inject(MAT_DIALOG_DATA) private data: any,
        private toastrService: ToastrService,
    ) { }

    get address() {
        return this.data?.address;
    }

    copyAddress() {
        navigator.clipboard.writeText(this.address);
        this.toastrService.info('Address Copied to clipboard', 'Copied')
    }

    close() {
        this.dialogRef.close();
    }
}
