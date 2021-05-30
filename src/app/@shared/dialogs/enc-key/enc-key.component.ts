import { Component, Inject } from '@angular/core';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { saveAs } from 'file-saver';

@Component({
  selector: 'enc-key-dialog',
  templateUrl: './enc-key.component.html',
  styleUrls: ['./enc-key.component.scss']
})
export class EncKeyDialog {

    constructor(
        public dialogRef: MatDialogRef<EncKeyDialog>,
        @Inject(MAT_DIALOG_DATA) public data: string,
    ) {}

    save() {
        const json = JSON.stringify(this.data);
        const blob = new Blob([json], { type: "text/plain;charset=utf-8" });
        saveAs(blob, 'tradeLayer-key.key')
    }

    close() {
        this.dialogRef.close();
    }
}
