import { CommonModule } from '@angular/common';
import { NgModule } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { TxBuilderDialog } from './tx-builder.component';
import { SendVestingTxTypeComponent } from './tx-types/send-vesting/send-vesting.tx-type.component';


const TX_TYPES = [
    SendVestingTxTypeComponent,
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
];

const imports = [
    ...NG_MODULES,
    ...MAT_MODULES,
]
const declarations = [
    TxBuilderDialog,
    ...TX_TYPES,
];

const exports = [
    TxBuilderDialog,
];

@NgModule({ imports, declarations, exports })

export class TxBuilderModule { }
