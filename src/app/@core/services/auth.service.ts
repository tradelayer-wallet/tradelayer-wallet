import { Injectable } from "@angular/core";
import { Router } from "@angular/router";
import { ToastrService } from "ngx-toastr";
import ltcUtils from '../../utils/litecore.util'
import { AddressService, IKeyPair } from "./address.service";
import { DialogService, DialogTypes } from "./dialogs.service";

@Injectable({
    providedIn: 'root',
})

export class AuthService {
    public encKey: string = '';

    constructor(
        private router: Router,
        private addressService: AddressService,
        private dialogService: DialogService,
        private toastrService: ToastrService,
    ) {}

    get isLoggedIn() {
        return this.addressService.keyPairs.length > 0;
    }

    register(pass: string) {
        const pair = ltcUtils.generateRandomAddress() as IKeyPair;
        if (pair.address && pair.wifKey) {
            this.addressService.addDecryptedKeyPair(pair);
            this.router.navigateByUrl('trading');
        };

        this.encKey = ltcUtils.encryptKeyPair(this.addressService.keyPairs, pass);
        this.dialogService.openEncKeyDialog(this.encKey);
    }

    loginFromKeyFile(key: string, pass: string) {
        const res = ltcUtils.decryptKeyPair(key, pass) as IKeyPair[];
        if (res?.length && res[0].address && res[0].wifKey) {
            this.login(res);
        } else {
            this.toastrService.error('Wrong Password or keyFile', 'Error');
        }
        this.encKey = ltcUtils.encryptKeyPair(this.addressService.keyPairs, pass);
    }

    login(pair: IKeyPair | IKeyPair[]) {
        Array.isArray(pair)
            ? pair.forEach((p: IKeyPair) => this.addressService.addDecryptedKeyPair(p))
            : this.addressService.addDecryptedKeyPair(pair);
        this.router.navigateByUrl('trading');
    }

    logout() {
        this.addressService.removeAllKeyPairs();
        this.router.navigateByUrl('login');
    }
}
