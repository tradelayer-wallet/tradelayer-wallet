import { Injectable } from "@angular/core";
import { MatDialog, MatDialogConfig } from "@angular/material/dialog";
import { NewVersionDialog } from "src/app/@shared/dialogs/new-version/new-version.component";
import { NewNodeDialog } from "src/app/@shared/dialogs/new-node/new-node.component";
import { SelectNetworkDialog } from "src/app/@shared/dialogs/select-network/select-network.component";
import { EncKeyDialog } from "src/app/@shared/dialogs/enc-key/enc-key.component";
import { DepositDialog } from "src/app/@shared/dialogs/deposit/deposit.component";
import { WithdrawDialog } from "src/app/@shared/dialogs/withdraw/withdraw.component";
import { CommingSoonDialog } from "src/app/@shared/dialogs/comming-soon/comming-soon.componet";
import { TransferDialog } from 'src/app/@shared/dialogs/transfer/transfer.component';

export enum DialogTypes {
    SELECT_NETOWRK = "SELECT_NETOWRK",
    NEW_VERSION = 'NEW_VERSION',
    ENC_KEY = "ENC_KEY",
    COMMING_SOON = 'COMMING_SOON',
    NEW_NODE = 'NEW_NODE',
    WITHDRAW = 'WITHDRAW',
    DEPOSIT = 'DEPOSIT',
    TRANSFER = 'TRANSFER',
};

const dialogs: { [key: string]: any; } = {
    'SELECT_NETOWRK': SelectNetworkDialog,
    'NEW_VERSION': NewVersionDialog,
    'NEW_NODE': NewNodeDialog,
    'ENC_KEY': EncKeyDialog,
    'COMMING_SOON': CommingSoonDialog,
    'WITHDRAW': WithdrawDialog,
    'DEPOSIT': DepositDialog,
    'TRANSFER': TransferDialog,
};

@Injectable({
    providedIn: 'root',
})

export class DialogService {
    
    constructor(
        private matDialogService: MatDialog,
    ) {}

    openEncKeyDialog(encKey: string) {
        const dialogOpts: MatDialogConfig = { disableClose: true, data: encKey };
        return this.openDialog(DialogTypes.ENC_KEY, dialogOpts)
    }

    openDialog(dialogType: DialogTypes, opts: MatDialogConfig = { disableClose: true }) {
        const dialog = dialogs[dialogType];
        if (!dialog) return;
        return this.matDialogService.open(dialog, opts);
    }

    closeAllDialogs() {
        this.matDialogService.closeAll();
    }
  }