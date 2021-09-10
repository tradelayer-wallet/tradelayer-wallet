import { NgModule } from '@angular/core';

import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ClipboardModule } from '@angular/cdk/clipboard'; 

import { MatDialogModule } from '@angular/material/dialog'; 
import { MatButtonModule } from '@angular/material/button'; 
import { MatInputModule } from '@angular/material/input'; 
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSidenavModule } from '@angular/material/sidenav'; 
import { MatExpansionModule } from '@angular/material/expansion'; 
import { MatCardModule } from '@angular/material/card';
import { MatCheckboxModule } from '@angular/material/checkbox'
import { MatProgressBarModule } from '@angular/material/progress-bar'; 

import { RPCConnectDialog } from './dialogs/rpc-connect/rpc-connect.component';
import { EncKeyDialog } from './dialogs/enc-key/enc-key.component';
import { CommingSoonDialog } from './dialogs/comming-soon/comming-soon.componet';
import { SideNavComponent } from './components/side-nav/side-nav.component';
import { DisconnectedLineComponent } from './components/disconnected-line/disconnected-line.component';
import { OverlayLoadingComponent } from './components/overlay-loading/overlay-loading.component';
import { MatTabsModule } from '@angular/material/tabs';
import { NewNodeDialog } from './dialogs/new-node/new-node.component';
import { SyncNodeDialog } from './dialogs/sync-node/sync-node.component';
import { RescanDialog } from './dialogs/rescan/rescan.component';

const NG_MODULES = [
    CommonModule,
    FormsModule,
    ClipboardModule,
];

const MAT_MODULES = [
    MatDialogModule,
    MatButtonModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatSidenavModule,
    MatExpansionModule,
    MatCardModule,
    MatTabsModule,
    MatCheckboxModule,
    MatProgressBarModule,
];

const DIALOGS = [
    RPCConnectDialog,
    EncKeyDialog,
    CommingSoonDialog,
    NewNodeDialog,
    SyncNodeDialog,
    RescanDialog,
];

const COMPONENTS = [
    SideNavComponent,
    DisconnectedLineComponent,
    OverlayLoadingComponent,
];

const imports = [
    ...NG_MODULES,
    ...MAT_MODULES,
];

const declarations = [
    ...DIALOGS,
    ...COMPONENTS,
];

const exports = [
    ...DIALOGS,
    ...COMPONENTS,
];

@NgModule({ imports, declarations, exports })

export class SharedModule { }
