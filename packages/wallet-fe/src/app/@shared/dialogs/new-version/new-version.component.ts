import { Component } from '@angular/core';
import { MatDialogRef } from '@angular/material/dialog';

@Component({
  selector: 'rpc-connect-dialog',
  templateUrl: './new-version.component.html',
  styleUrls: ['./new-version.component.scss'],
})

export class NewVersionDialog {
  constructor(
    public dialogRef: MatDialogRef<NewVersionDialog>,
  ) {}

  download() {
      console.log(`Download new version!`);
  }
}
