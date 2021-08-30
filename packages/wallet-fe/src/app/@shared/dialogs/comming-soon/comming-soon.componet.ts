import { Component } from '@angular/core';
import { MatDialogRef } from '@angular/material/dialog';
import { DialogService } from 'src/app/@core/services/dialogs.service';

@Component({
  selector: 'tl-comming-soon-dialog',
  templateUrl: './comming-soon.componet.html',
  styleUrls: ['./comming-soon.componet.scss']
})
export class CommingSoonDialog {
  constructor(
      private dialogService: DialogService,
      public dialogRef: MatDialogRef<CommingSoonDialog>,
  ) { }

  closeDialog() {
      this.dialogRef.close();
  }
}
