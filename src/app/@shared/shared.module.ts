import { NgModule } from '@angular/core';

import { MatDialogModule } from '@angular/material/dialog'; 

import { RPCConnectDialog } from './dialogs/rpc-connect/rpc-connect.component';

@NgModule({
    imports: [
        MatDialogModule,
    ],
    declarations: [
        RPCConnectDialog,
    ],
    exports: [
        RPCConnectDialog,
    ]
})

export class SharedModule { }
