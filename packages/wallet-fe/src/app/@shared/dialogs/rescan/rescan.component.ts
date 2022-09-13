import { Component, Inject } from '@angular/core';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { ToastrService } from 'ngx-toastr';
import { AuthService } from 'src/app/@core/services/auth.service';
import { RpcService } from 'src/app/@core/services/rpc.service';

@Component({
  selector: 'rescan-dialog',
  templateUrl: './rescan.component.html',
  styleUrls: ['./rescan.component.scss']
})
export class RescanDialog {
    scannign: boolean = false;
    abortDisabled: boolean = false;

    constructor(
        @Inject(MAT_DIALOG_DATA) private data: any,
        public dialogRef: MatDialogRef<RescanDialog>,
        private rpcService: RpcService,
        private toastrService: ToastrService,
        private authService: AuthService,
    ) { }

    async rescan() {
        // this.scannign = true;
        // const rbRes = await this.rpcService.rpc('rescanblockchain');

        // if (rbRes.error || !rbRes.data) {
        //     this.toastrService.error(rbRes.error || 'Error with Blockchain Rescan!', 'Error');
        //     this.scannign = false;
        //     return;
        // }
        // const { key, pass } = this.data;
        // if (key && pass) this.authService.loginFromKeyFile(this.data.key, this.data.pass);
        // this.close();
    }

    close() {
        this.dialogRef.close();
    }

    async abort() {
        if (!this.scannign) return;
        this.abortDisabled = true;
        const arRes = await this.rpcService.rpc('abortrescan');
        this.abortDisabled = false;
    }
}
