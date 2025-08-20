import { Component, Inject } from '@angular/core';
import { FormBuilder, FormGroup } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';

export interface UploadSystemDialogData {
  defaultPublic?: boolean;
}

export interface UploadSystemDialogResult {
  file: File;
  isPublic: boolean;
  name?: string;
}

@Component({
  selector: 'tl-upload-system-dialog',
  templateUrl: './upload-system-dialog.component.html',
  styleUrls: ['./upload-system-dialog.component.scss'],
})
export class UploadSystemDialogComponent {
  form: FormGroup = this.fb.group({
    name: [''],
    isPublic: [this.data?.defaultPublic ?? false],
  });

  selectedFile?: File;
  dragOver = false;

  constructor(
    private fb: FormBuilder,
    private dialogRef: MatDialogRef<UploadSystemDialogComponent, UploadSystemDialogResult>,
    @Inject(MAT_DIALOG_DATA) public data: UploadSystemDialogData
  ) {}

  onFileSelected(evt: Event) {
    const input = evt.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) this.selectedFile = file;
  }

  onDrop(evt: DragEvent) {
    evt.preventDefault();
    this.dragOver = false;
    const file = evt.dataTransfer?.files?.[0];
    if (file) this.selectedFile = file;
  }

  onDragOver(evt: DragEvent) {
    evt.preventDefault();
    this.dragOver = true;
  }
  onDragLeave(evt: DragEvent) {
    evt.preventDefault();
    this.dragOver = false;
  }

  cancel() {
    this.dialogRef.close();
  }

  submit() {
    if (!this.selectedFile) return;
    const { isPublic, name } = this.form.value;
    this.dialogRef.close({
      file: this.selectedFile,
      isPublic: !!isPublic,
      name: name?.trim() || undefined,
    });
  }
}
