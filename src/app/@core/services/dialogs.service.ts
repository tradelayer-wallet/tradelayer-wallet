import { Injectable } from "@angular/core";
import { MatDialog, MatDialogConfig } from "@angular/material/dialog";
import { CommingSoonDialog } from "src/app/@shared/dialogs/comming-soon/comming-soon.componet";
import { EncKeyDialog } from "src/app/@shared/dialogs/enc-key/enc-key.component";
import { RPCConnectDialog } from "src/app/@shared/dialogs/rpc-connect/rpc-connect.component";

export enum DialogTypes {
    RPC_CONNECT = "RPC_CONNECT",
    ENC_KEY = "ENC_KEY",
    COMMING_SOON = 'COMMING_SOON',
};

const dialogs: { [key: string]: any; } = {
    'RPC_CONNECT': RPCConnectDialog,
    'ENC_KEY': EncKeyDialog,
    'COMMING_SOON': CommingSoonDialog
};

@Injectable({
    providedIn: 'root',
})

export class DialogService {
    
    constructor(
        private matDialogService: MatDialog,
    ) {}

    openEncKeyDialog(encKey: string) {
        const dialogOpts: MatDialogConfig = {
            disableClose: false,
            data: encKey,
        };
        this.openDialog(DialogTypes.ENC_KEY, dialogOpts)
    }

    openDialog(dialogType: DialogTypes, opts: MatDialogConfig = { disableClose: true }) {
        const dialog = dialogs[dialogType];
        if (!dialog) return;
        this.matDialogService.open(dialog, opts);
    }

    closeAllDialogs() {
        this.matDialogService.closeAll();
    }
  }