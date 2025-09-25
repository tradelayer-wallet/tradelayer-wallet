import { Component, Inject } from '@angular/core';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { AlgoTradingService } from '../../../@core/services/algo-trading.service';

@Component({
  selector: 'tl-upload-system-dialog',
  templateUrl: './upload-system-dialog.component.html',
  styleUrls: ['./upload-system-dialog.component.scss'],
})
export class UploadSystemDialogComponent {
  uploading = false;
  errorMsg = '';

  // ✨ template expects these
  dragOver = false;
  selectedFile: File | null = null;

  constructor(
    private ref: MatDialogRef<UploadSystemDialogComponent>,
    private svc: AlgoTradingService,
    @Inject(MAT_DIALOG_DATA) public data: unknown
  ) {}

  // drag & drop handlers
  onDragOver(evt: DragEvent) {
    evt.preventDefault();
    this.dragOver = true;
  }

  onDragLeave(evt: DragEvent) {
    evt.preventDefault();
    this.dragOver = false;
  }

  onDrop(evt: DragEvent) {
    evt.preventDefault();
    this.dragOver = false;
    const file = evt.dataTransfer?.files?.[0];
    if (file) this.selectedFile = file;
  }

  // file input change
  onFileSelected(evt: Event) {
    const input = evt.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) this.selectedFile = file;
  }

  // footer buttons
  cancel() {
    this.ref.close();
  }

  submit() {
    if (!this.selectedFile) return;
    this.uploading = true;
    this.svc.uploadSystem(this.selectedFile).subscribe({
      next: (res) => this.ref.close(res),
      error: (err) => {
        this.uploading = false;
        this.errorMsg = err?.message || 'Upload failed';
      },
    });
  }
}
