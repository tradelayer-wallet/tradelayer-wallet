import { NgModule } from '@angular/core';

import { FormsModule } from '@angular/forms';


import { MatDialogModule } from '@angular/material/dialog'; 
import { MatButtonModule } from '@angular/material/button'; 
import { MatInputModule } from '@angular/material/input'; 
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

import { RPCConnectDialog } from './dialogs/rpc-connect/rpc-connect.component';
import { CommonModule } from '@angular/common';
import { SideNavComponent } from './components/side-nav/side-nav.component';
import { MatSidenavModule } from '@angular/material/sidenav'; 
import { MatExpansionModule } from '@angular/material/expansion'; 
import { MatCardModule } from '@angular/material/card';
import { EncKeyDialog } from './dialogs/enc-key/enc-key.component';
import { ClipboardModule } from '@angular/cdk/clipboard'; 

@NgModule({
    imports: [
        CommonModule,
        FormsModule,
        MatDialogModule,
        MatButtonModule,
        MatInputModule,
        MatProgressSpinnerModule,
        MatSidenavModule,
        MatExpansionModule,
        MatCardModule,
        ClipboardModule,
    ],
    declarations: [
        RPCConnectDialog,
        EncKeyDialog,
        SideNavComponent,
    ],
    exports: [
        RPCConnectDialog,
        EncKeyDialog,
        SideNavComponent,
        MatProgressSpinnerModule,
    ]
})

export class SharedModule { }
