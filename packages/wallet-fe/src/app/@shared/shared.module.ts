import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ClipboardModule } from '@angular/cdk/clipboard'; 
import { FormsModule, ReactiveFormsModule } from '@angular/forms';
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
import { MatSelectModule } from '@angular/material/select'; 
import { MatTabsModule } from '@angular/material/tabs';
import { MatSliderModule } from '@angular/material/slider';
import { MatFormFieldModule } from '@angular/material/form-field';

import { SideNavComponent } from './components/side-nav/side-nav.component';
import { InfoLineComponent } from '../@shared/components/info-line/info-line.component';
import { DisconnectedLineComponent } from './components/disconnected-line/disconnected-line.component';
import { OverlayLoadingComponent } from './components/overlay-loading/overlay-loading.component';

import { SelectNetworkDialog } from './dialogs/select-network/select-network.component';
import { NewVersionDialog } from './dialogs/new-version/new-version.component';
import { SyncNodeDialog } from './dialogs/sync-node/sync-node.component';
import { NewNodeDialog } from './dialogs/new-node/new-node.component';
import { TerminalDialog } from './dialogs/terminal/terminal.component';

import { WindowComponent } from './components/window/window.component';
import { EncKeyDialog } from './dialogs/enc-key/enc-key.component';
import { PasswordDialog } from './dialogs/password/password.component';
import { WithdrawDialog } from './dialogs/withdraw/withdraw.component';
import { DepositDialog } from './dialogs/deposit/deposit.component';
import { CommingSoonDialog } from './dialogs/comming-soon/comming-soon.componet';
import { ServersDialog } from './dialogs/servers/servers.component';
import { TransferDialog } from './dialogs/transfer/transfer.component';
import { PasswordPromptDialog } from './dialogs/password-prompt/password-prompt.component';
import { UploadSystemDialogComponent } from './dialogs/upload-system-dialog/upload-system-dialog.component';
import {SynthMintRedeemDialogComponent } from './dialogs/synth/synth-mint-redeem-dialog.component'

const NG_MODULES = [
    CommonModule,
    FormsModule,
    ClipboardModule,
    ReactiveFormsModule
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
    MatSliderModule,
    MatFormFieldModule
];

const DIALOGS = [
    SelectNetworkDialog,
    NewVersionDialog,
    SyncNodeDialog,
    NewNodeDialog,
    TerminalDialog,
    EncKeyDialog,
    PasswordDialog,
    WithdrawDialog,
    DepositDialog,
    PasswordPromptDialog, // Use consistent naming
    CommingSoonDialog,
    ServersDialog,
    TransferDialog,
    UploadSystemDialogComponent,
    SynthMintRedeemDialogComponent
];

const COMPONENTS = [
    SideNavComponent,
    DisconnectedLineComponent,
    OverlayLoadingComponent,
    InfoLineComponent,
    WindowComponent
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
    ...NG_MODULES,
    ...MAT_MODULES, 
];

@NgModule({ imports, declarations, exports })

export class SharedModule { }
