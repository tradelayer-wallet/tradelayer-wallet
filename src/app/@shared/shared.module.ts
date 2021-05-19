import { NgModule } from '@angular/core';

import { FormsModule } from '@angular/forms';


import { MatDialogModule } from '@angular/material/dialog'; 
import { MatButtonModule } from '@angular/material/button'; 
import { MatInputModule } from '@angular/material/input'; 
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

import { RPCConnectDialog } from './dialogs/rpc-connect/rpc-connect.component';
import { CommonModule } from '@angular/common';

@NgModule({
    imports: [
        CommonModule,
        FormsModule,
        MatDialogModule,
        MatButtonModule,
        MatInputModule,
        MatProgressSpinnerModule,
    ],
    declarations: [
        RPCConnectDialog,
    ],
    exports: [
        RPCConnectDialog,
    ]
})

export class SharedModule { }
