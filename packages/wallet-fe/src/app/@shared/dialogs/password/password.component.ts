import { Component } from '@angular/core';
import { MatDialogRef } from '@angular/material/dialog';

@Component({
  selector: 'password-dialog',
  templateUrl: './password.component.html',
  styleUrls: ['./password.component.scss']
})
export class PasswordDialog {
    password: string = '';
    constructor(
        public dialogRef: MatDialogRef<PasswordDialog>,
    ) { }

    validate() {
        this.dialogRef.close();
    }

    close() {
        this.dialogRef.close();
    }
}
