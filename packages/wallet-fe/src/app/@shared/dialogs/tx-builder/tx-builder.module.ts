import { CommonModule } from '@angular/common';
import { NgModule } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatTabsModule } from '@angular/material/tabs';
import { TxBuilderBuildTabComponent } from './tabs/build/build-tab.component';
import { TxBuilderDecodeTabComponent } from './tabs/decode/decode-tab.component';
import { TxBuilderSendTabComponent } from './tabs/send/send-tab.component';
import { TxBuilderSignTabComponent } from './tabs/sign/sign-tab.component';
import { TxBuilderDialog } from './tx-builder.component';
import { SendVestingTxTypeComponent } from './tx-types/send-vesting/send-vesting.tx-type.component';


const TX_TYPES = [
    SendVestingTxTypeComponent,
];

const TABS = [
    TxBuilderBuildTabComponent,
    TxBuilderSignTabComponent,
    TxBuilderSendTabComponent,
    TxBuilderDecodeTabComponent,
];

const NG_MODULES = [
    CommonModule,
    FormsModule,
];

const MAT_MODULES = [
    MatButtonModule,
    MatInputModule,
    MatCheckboxModule,
    MatIconModule,
    MatSelectModule,
    MatTabsModule,
    MatProgressSpinnerModule,
];

const imports = [
    ...NG_MODULES,
    ...MAT_MODULES,
]
const declarations = [
    TxBuilderDialog,
    ...TABS,
    ...TX_TYPES,
];

const exports = [
    TxBuilderDialog,
];

@NgModule({ imports, declarations, exports })

export class TxBuilderModule { }
