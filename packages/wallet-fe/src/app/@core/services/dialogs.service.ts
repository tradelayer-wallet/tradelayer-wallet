import { Injectable } from "@angular/core";
import { MatDialog, MatDialogConfig } from "@angular/material/dialog";
// import { CommingSoonDialog } from "src/app/@shared/dialogs/comming-soon/comming-soon.componet";
// import { DepositDialog } from "src/app/@shared/dialogs/deposit/deposit.component";
// import { EncKeyDialog } from "src/app/@shared/dialogs/enc-key/enc-key.component";
// import { NewMultisigDialog } from "src/app/@shared/dialogs/new-multisig/new-multisig.component";
// import { NewNodeDialog } from "src/app/@shared/dialogs/new-node/new-node.component";
// import { NewVersionDialog } from "src/app/@shared/dialogs/new-version/new-version.component";
// import { OfflineWalletDialog } from "src/app/@shared/dialogs/offline-wallet/offline-wallet.component";
// import { RescanDialog } from "src/app/@shared/dialogs/rescan/rescan.component";
// import { RPCConnectDialog } from "src/app/@shared/dialogs/rpc-connect/rpc-connect.component";
// import { TxBuilderDialog } from "src/app/@shared/dialogs/tx-builder/tx-builder.component";
// import { WithdrawDialog } from "src/app/@shared/dialogs/withdraw/withdraw.component";

export enum DialogTypes {
    RPC_CONNECT = "RPC_CONNECT",
    ENC_KEY = "ENC_KEY",
    COMMING_SOON = 'COMMING_SOON',
    NEW_NODE = 'NEW_NODE',
    RESCAN = 'RESCAN',
    WITHDRAW = 'WITHDRAW',
    DEPOSIT = 'DEPOSIT',
    NEW_MULTISIG = 'NEW_MULTISIG',
    TX_BUILDER = 'TX_BUILDER',
    NEW_VERSION = 'NEW_VERSION',
    OFFLINE_WALLET = 'OFFLINE_WALLET',
};

const dialogs: { [key: string]: any; } = {
    // 'RPC_CONNECT': RPCConnectDialog,
    // 'ENC_KEY': EncKeyDialog,
    // 'COMMING_SOON': CommingSoonDialog,
    // 'NEW_NODE': NewNodeDialog,
    // 'RESCAN': RescanDialog,
    // 'WITHDRAW': WithdrawDialog,
    // 'DEPOSIT': DepositDialog,
    // 'NEW_MULTISIG': NewMultisigDialog,
    // 'TX_BUILDER': TxBuilderDialog,
    // 'NEW_VERSION': NewVersionDialog,
    // 'OFFLINE_WALLET': OfflineWalletDialog,
};

@Injectable({
    providedIn: 'root',
})

export class DialogService {
    
    constructor(
        private matDialogService: MatDialog,
    ) {}

    openEncKeyDialog(encKey: string) {
        // const dialogOpts: MatDialogConfig = {
        //     disableClose: true,
        //     data: encKey,
        // };
        // return this.openDialog(DialogTypes.ENC_KEY, dialogOpts)
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