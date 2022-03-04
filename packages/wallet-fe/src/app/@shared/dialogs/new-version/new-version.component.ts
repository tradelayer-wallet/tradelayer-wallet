import { AfterViewInit, Component, NgZone, OnInit } from '@angular/core';
import { MatDialogRef } from '@angular/material/dialog';
import { DialogService, DialogTypes } from 'src/app/@core/services/dialogs.service';
import { ElectronService } from 'src/app/@core/services/electron.service';

@Component({
  selector: 'rpc-connect-dialog',
  templateUrl: './new-version.component.html',
  styleUrls: ['./new-version.component.scss'],
})

export class NewVersionDialog implements OnInit {
  public message: string = 'Checking for updates...';
  public loading: boolean = true;
  public downloadButton: boolean = false;
  constructor(
    public dialogRef: MatDialogRef<NewVersionDialog>,
    private electronService: ElectronService,
    private dialogService: DialogService,
    private ngZone: NgZone,
  ) {}

  ngOnInit() {
    this.handleUpdateEvents();
    window.navigator.onLine
      ? this.electronService.emitEvent('check-version')
      : this.close();
    
  }

  private handleUpdateEvents() {
    this.electronService.ipcRenderer.on('angular-electron-message', (channel: any, _data: any) => {
          if (_data.event !== 'update-app') return;
          this.loading = true;
          this.downloadButton = false;
          const state = _data.data.state;
          const message = _data.data.data;

          this.ngZone.run(() => {
            switch (state) {
              case 1:
                this.message = 'Error with updating the app';
                this.close();
                break;
              case 2:
                this.message = 'Checking for updates...';
                break;
              case 3:
                this.close();
                break;
              case 4:
                this.message = 'New Update Found';
                this.loading = false;
                this.downloadButton = true;
                break;
              case 5:
                this.message = 'Downloading...';
                break;
              case 6:
                this.message = 'Installing...';
                break;
              default:
                break;
            }
          });
      });
  }

  download() {
      this.electronService.emitEvent('download-new-version');
  }

  close() {
    this.dialogRef.close();
    this.dialogService.openDialog(DialogTypes.RPC_CONNECT);
  }
}
