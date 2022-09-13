import { Component, Inject, OnInit } from '@angular/core';
import { FormBuilder, FormGroup } from '@angular/forms';
import { MatDialog, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { ToastrService } from 'ngx-toastr';
import { first } from 'rxjs/operators';
import { LoadingService } from 'src/app/@core/services/loading.service';
import { RpcService } from 'src/app/@core/services/rpc.service';
import { PasswordDialog } from '../password/password.component';
import { AuthService } from '../../../@core/services/auth.service';
import { encrypt, decrypt } from '../../../utils/crypto.util';
import { DialogService } from 'src/app/@core/services/dialogs.service';
enum KeyTypes {
    HOT = 'HOT',
    AIRGAP = 'AIRGAP',
    HARDWARE = 'HARDWARE',
    SERVER = 'SERVER',
};

@Component({
  selector: 'new-multisig-dialog',
  templateUrl: './new-multisig.component.html',
  styleUrls: ['./new-multisig.component.scss']
})
export class NewMultisigDialog implements OnInit {
    private _nRequired: number = 2;
    private _nAllKeys: number = 2;
    private mainForm: FormGroup = new FormGroup({});

    public errorMessage: string = ' ';
    // public multisigAddressData: IMultisigPair | undefined;
    public validateInfo: string = '';
    constructor(
        @Inject(MAT_DIALOG_DATA) private data: any,
        public dialogRef: MatDialogRef<NewMultisigDialog>,
        public matDialog: MatDialog,
        private rpcService: RpcService,
        private formBuilder: FormBuilder,
        private toastrService: ToastrService,
        private loadingService: LoadingService,
        private authService: AuthService,
        private dialogService: DialogService,
    ) { }

    get keyPair(){
        return this.authService.activeMainKey;
    }

    get activeKeys(): any[] {
        return this.mainForm.value.keys
    }

    get keyTypes(){
        return KeyTypes
    }

    get nAllKeys() {
        return this._nAllKeys;
    }

    set nAllKeys(value: number) {
        this._nAllKeys = value;
    }

    get nRequired() {
        return this._nRequired;
    }

    set nRequired(value: number) {
        this._nRequired = value;
    }

    get buttonDisabled() {
        return !this.activeKeys.every(e => e.pubkey);
    }

    get hotKeySelected() {
        return this.activeKeys.some(e => e.type === this.keyTypes.HOT);
    }

    ngOnInit() {
        this.buildForms();
    }

    private changeKeyFields(action: 'add' | 'remove') {
        if(action === 'add') {
            this.nAllKeys = this.nAllKeys + 1;
            const oldValue: any[] = this.mainForm.value.keys;
            const newField = { id: oldValue.length + 1 };
            const newValue = [...oldValue, newField];
            this.mainForm.controls.keys.setValue(newValue);
        }

        if (action === 'remove') {
            this.nAllKeys = this.nAllKeys - 1;
            if (this.nRequired > this.nAllKeys) this.nRequired = this.nAllKeys;
            const oldValue: any[] = this.mainForm.value.keys;
            const newValue = oldValue.slice(0, -1);
            this.mainForm.controls.keys.setValue(newValue);
        }
   
    }

    private buildForms() {
        const keys = Array(this.nAllKeys)
            .fill(true)
            .map((key: any, n: number) => ({ id: n + 1 }));
        this.mainForm = this.formBuilder.group({
            keys: [keys]
        });
    }

    changePubKey(event: any, key: any) {
        const value = event.target.value;
        if (key.type === KeyTypes.AIRGAP) key.pubkey = value;
    }

    changeKeyType(event: any, key: any ) {
        this.errorMessage = ' ';
        const { value } = event;
        if (value === this.keyTypes.HOT && this.activeKeys.some(k => k.type === KeyTypes.HOT)) {
            this.toastrService.error('You cant set 2 HOT keys');
            return;
        } 
        key.type = value;
        if (value === KeyTypes.HOT) key.pubkey = this.keyPair?.pubkey;
        if (value === KeyTypes.AIRGAP) key.pubkey = '';
    }

    nKeysChange(keysType: 'required' | 'all', action: 'add' | 'remove') {
        if (keysType === 'required'){
            if (action === 'add') {
                this.nRequired < this.nAllKeys
                    ? this.nRequired = this.nRequired + 1
                    : null
            }
            if (action === 'remove') {
                this.nRequired > 2
                ? this.nRequired = this.nRequired - 1
                : null
            }
        }

        if (keysType === 'all'){
            if (action === 'add') {
                this.nAllKeys < 7
                    ? this.changeKeyFields('add')
                    : null
            }
            if (action === 'remove') {
                this.nAllKeys > 2
                    ? this.changeKeyFields('remove')
                    : null
            }
        }
    }

    async create() {
        // this.loadingService.isLoading = true;
        // this.validateInfo = '';
        // this.errorMessage = ' ';
        // const pubkeys = this.mainForm.value.keys.map((e: any) => e.pubkey);
        // const createRes = await this.rpcService.rpc('addmultisigaddress', [this.nRequired, pubkeys]);

        // if (createRes.error || !createRes.data) {
        //     this.errorMessage = createRes.error;
        //     this.loadingService.isLoading = false;
        //     return;
        // }

        // this.multisigAddressData = createRes.data;
        // this.validateInfo = JSON.stringify(createRes.data, null, 4);
        // const validateRes = await this.rpcService.rpc('validateaddress', [createRes.data.address]);

        // if (validateRes.error || !validateRes.data) {
        //     this.errorMessage = validateRes.error;
        //     this.loadingService.isLoading = false;
        //     return;
        // }
        // if (this.multisigAddressData) {
        //     this.validateInfo += JSON.stringify(validateRes.data, null, 4);
        //     this.multisigAddressData.nRequired = this.nRequired;
        //     this.multisigAddressData.nAllKeys = this.nAllKeys;
        //     this.multisigAddressData.keys = validateRes.data.embedded.pubkeys;
        // }
        // this.loadingService.isLoading = false;
    }

    async save() {
        // const passDialog = this.matDialog.open(PasswordDialog);
        // const password = await passDialog.afterClosed()
        //     .pipe(first())
        //     .toPromise();
        // if (!password) return;
        // const encKey = this.authService.encKey;
        // const decryptResult = decryptKeyPair(encKey, password);
        // if (!decryptResult) {
        //     this.toastrService.error('Wrong Password', 'Error');
        // } else {
        //     if (this.multisigAddressData) {
        //         this.addressService.addMultisigAddress(this.multisigAddressData);
        //         const allKeyParis = [
        //             ...this.addressService.keyPairs, 
        //             ...this.addressService.multisigPairs, 
        //             ...this.addressService.rewardAddresses,
        //             ...this.addressService.liquidityAddresses,
        //         ];
        //         this.authService.encKey = encryptKeyPair(allKeyParis, password);
        //         this.dialogService.openEncKeyDialog(this.authService.encKey);
        //         this.close();
        //     }

        // }
    }

    close() {
        this.dialogRef.close();
    }
}
