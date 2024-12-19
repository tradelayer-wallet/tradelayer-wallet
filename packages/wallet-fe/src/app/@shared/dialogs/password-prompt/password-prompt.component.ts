import { Component, Inject } from '@angular/core';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';

@Component({
  selector: 'app-password-prompt',
  templateUrl: './password-prompt.component.html',
  styleUrls: ['./password-prompt.component.scss'],
})
export class PasswordPromptDialog {
  password: string = '';

  constructor(
    private dialogRef: MatDialogRef<PasswordPromptDialog>,
    @Inject(MAT_DIALOG_DATA) public data: any
  ) {}

  submit() {
    this.dialogRef.close(this.password);
  }

  cancel() {
    this.dialogRef.close(null);
  }
}
