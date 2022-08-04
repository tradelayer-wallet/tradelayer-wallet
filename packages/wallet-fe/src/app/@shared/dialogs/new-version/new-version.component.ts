import { AfterViewInit, Component, NgZone, OnInit } from '@angular/core';
import { MatDialogRef } from '@angular/material/dialog';
import { ConnectionService } from 'src/app/@core/services/connections.service';
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
    private connectionService: ConnectionService,
    private ngZone: NgZone,
  ) {}

  ngOnInit() {
    this.handleUpdateEvents();
    this.connectionService.isOnline
      ? this.electronService.emitEvent('check-version')
      : this.handleOffline();
    
  }

  private handleOffline() {
    this.message = 'No internet Connection';
    const sub = this.connectionService.isOnline$.subscribe(isOnline => {
      if (!isOnline) return;
      this.electronService.emitEvent('check-version');
      sub.unsubscribe();
    });
  }

  private handleUpdateEvents() {
    this.electronService.ipcRenderer.on('angular-electron-message', (channel: any, _data: any) => {
          if (_data.event !== 'update-app') return;
          this.loading = true;
          this.downloadButton = false;
          const { state } = _data.data;
          this.ngZone.run(() => {
            switch (state) {
              case 1:
                this.message = 'Error with updating the app. Please exit and try again';
                break;
              case 2:
                this.message = 'Checking for updates...';
                break;
              case 3:
                this.message = 'Tradelayer wallet is Up To Date';
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
    this.dialogService.openDialog(DialogTypes.SELECT_NETOWRK);
  }
}
