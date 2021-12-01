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
import { MatIconModule } from '@angular/material/icon'; 

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
import { WithdrawDialog } from './dialogs/withdraw/withdraw.component';
import { DepositDialog } from './dialogs/deposit/deposit.component';
import { InfoLineComponent } from '../@shared/components/info-line/info-line.component';
import { NewMultisigDialog } from './dialogs/new-multisig/new-multisig.component';
import { MatSelectModule } from '@angular/material/select'; 
import { PasswordDialog } from './dialogs/password/password.component';
import { ClickOutsideDirective } from './directives/click-outside.directive';
import { TxBuilderModule } from './dialogs/tx-builder/tx-builder.module';


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
    MatIconModule,
    MatSelectModule,
];

const DIALOGS = [
    RPCConnectDialog,
    EncKeyDialog,
    CommingSoonDialog,
    NewNodeDialog,
    SyncNodeDialog,
    RescanDialog,
    WithdrawDialog,
    DepositDialog,
    NewMultisigDialog,
    PasswordDialog,
];

const COMPONENTS = [
    SideNavComponent,
    DisconnectedLineComponent,
    OverlayLoadingComponent,
    InfoLineComponent,
];

const imports = [
    ...NG_MODULES,
    ...MAT_MODULES,
    TxBuilderModule,
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
