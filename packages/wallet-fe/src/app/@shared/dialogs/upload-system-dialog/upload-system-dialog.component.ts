import { Component, Inject } from '@angular/core';
import { FormBuilder, FormGroup } from '@angular/forms';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { AlgoTradingService } from './algo-trading-service';

@Component({
  selector: 'tl-upload-system-dialog',
  templateUrl: './upload-system-dialog.component.html'
})
export class UploadSystemDialogComponent {
  form: FormGroup;
  selectedFile?: File;
  dragOver = false;

  constructor(
    private fb: FormBuilder,
    private svc: AlgoTradingService,
    private ref: MatDialogRef<UploadSystemDialogComponent>,
    @Inject(MAT_DIALOG_DATA) public data: any
  ) {
    this.form = this.fb.group({
      name: [''],
      isPublic: [false]
    });
  }

  onDragOver(evt: DragEvent) {
    evt.preventDefault();
    evt.stopPropagation();
    this.dragOver = true;
  }
  onDragLeave(evt: DragEvent) {
    evt.preventDefault();
    evt.stopPropagation();
    this.dragOver = false;
  }
  onDrop(evt: DragEvent) {
    evt.preventDefault();
    evt.stopPropagation();
    this.dragOver = false;
    const files = evt.dataTransfer?.files;
    if (files && files.length) {
      this.selectedFile = files[0];
    }
  }
  onFileSelected(evt: Event) {
    const input = evt.target as HTMLInputElement;
    if (input.files && input.files.length) {
      this.selectedFile = input.files[0];
    }
  }

  cancel() {
    this.ref.close();
  }

  submit() {
    if (!this.selectedFile) return;
    const { name, isPublic } = this.form.value;
    this.svc.uploadSystem(this.selectedFile, name, isPublic).subscribe({
      next: (res) => this.ref.close(res),
      error: (err) => this.ref.close({ ok: false, error: err?.message || 'Upload failed' })
    });
  }
}
