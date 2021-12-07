import { Component, Inject } from '@angular/core';
import { MatDialog, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { saveAs } from 'file-saver';
import { ToastrService } from 'ngx-toastr';
import { first } from 'rxjs/operators';
import { decryptKeyPair } from 'src/app/utils/litecore.util';
import { PasswordDialog } from '../password/password.component';

@Component({
  selector: 'enc-key-dialog',
  templateUrl: './enc-key.component.html',
  styleUrls: ['./enc-key.component.scss']
})
export class EncKeyDialog {
    public decodedJson: string = '';

    constructor(
        public dialogRef: MatDialogRef<EncKeyDialog>,
        @Inject(MAT_DIALOG_DATA) public data: string,
        public matDialog: MatDialog,
        private toastrService: ToastrService,
    ) {}

    save() {
        const json = JSON.stringify(this.data);
        const blob = new Blob([json], { type: "text/plain;charset=utf-8" });
        saveAs(blob, 'tradeLayer-key.key')
    }

    async decode() {
        const passDialog = this.matDialog.open(PasswordDialog);
        const password = await passDialog.afterClosed()
            .pipe(first())
            .toPromise();

        if (!password) return;
        const encKey = this.data;
        const decryptResult = decryptKeyPair(encKey, password);
        if (!decryptResult) {
            this.toastrService.error('Wrong Password', 'Error');
        } else {
            this.decodedJson = JSON.stringify(decryptResult,  null, 4);
        }
        console.log(this.decodedJson);
    }

    close() {
        this.dialogRef.close();
    }
}
