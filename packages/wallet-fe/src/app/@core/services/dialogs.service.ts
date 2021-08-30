import { Injectable } from "@angular/core";
import { MatDialog, MatDialogConfig } from "@angular/material/dialog";
import { CommingSoonDialog } from "src/app/@shared/dialogs/comming-soon/comming-soon.componet";
import { EncKeyDialog } from "src/app/@shared/dialogs/enc-key/enc-key.component";
import { NewNodeDialog } from "src/app/@shared/dialogs/new-node/new-node.component";
import { RPCConnectDialog } from "src/app/@shared/dialogs/rpc-connect/rpc-connect.component";
import { SyncNodeDialog } from "src/app/@shared/dialogs/sync-node/sync-node.component";

export enum DialogTypes {
    RPC_CONNECT = "RPC_CONNECT",
    ENC_KEY = "ENC_KEY",
    COMMING_SOON = 'COMMING_SOON',
    NEW_NODE = 'NEW_NODE',
    SYNC_NODE = 'SYNC_NODE',
};

const dialogs: { [key: string]: any; } = {
    'RPC_CONNECT': RPCConnectDialog,
    'ENC_KEY': EncKeyDialog,
    'COMMING_SOON': CommingSoonDialog,
    'NEW_NODE': NewNodeDialog,
    'SYNC_NODE': SyncNodeDialog,
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