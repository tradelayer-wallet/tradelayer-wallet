import { Injectable } from "@angular/core";
import { MatDialog } from "@angular/material/dialog";
import { RPCConnectDialog } from "src/app/@shared/dialogs/rpc-connect/rpc-connect.component";

export enum DialogTypes {
    RPC_CONNECT = "RPC_CONNECT",
};

const dialogs: { [key: string]: any; } = {
    'RPC_CONNECT': RPCConnectDialog,
};

@Injectable({
    providedIn: 'root',
})

export class DialogService {
    
    constructor(
        private matDialogService: MatDialog,
    ) {}

    openDialog(dialogType: DialogTypes) {
        const dialog = dialogs[dialogType];
        if (!dialog) return;
        this.matDialogService.open(dialog);
    }
  }