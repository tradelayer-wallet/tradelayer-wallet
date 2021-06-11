import { Injectable } from "@angular/core";
import { Router } from "@angular/router";
import { ToastrService } from "ngx-toastr";
import ltcUtils from '../../utils/litecore.util'
import { AddressService, IKeyPair } from "./address.service";
import { BalanceService } from "./balance.service";
import { DialogService, DialogTypes } from "./dialogs.service";
import { SocketService } from "./socket.service";

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
        private socketService: SocketService,
        private balanceService: BalanceService,
    ) {}

    get isLoggedIn() {
        return this.addressService.keyPairs.length > 0;
    }

    async register(pass: string) {
        const pair = await this.addressService.generateNewKeyPair() as IKeyPair;
        if (pair.address && pair.privKey, pair.pubKey) {
            this.login(pair);
        };

        this.encKey = ltcUtils.encryptKeyPair(this.addressService.keyPairs, pass);
        this.dialogService.openEncKeyDialog(this.encKey);
    }

    loginFromKeyFile(key: string, pass: string) {
        const res = ltcUtils.decryptKeyPair(key, pass) as IKeyPair[];
        if (res?.length && res[0].address && res[0].pubKey && res[0].privKey) {
            this.login(res);
        } else {
            this.toastrService.error('Wrong Password or keyFile', 'Error');
        }
        this.encKey = ltcUtils.encryptKeyPair(this.addressService.keyPairs, pass);
    }

    login(pair: IKeyPair | IKeyPair[]) {
        Array.isArray(pair)
            ? pair.forEach((p: IKeyPair) => {
                    this.addressService.addDecryptedKeyPair(p);
                    this.balanceService.updateLtcBalanceForAddress(p.address);
                })
            : this.addressService.addDecryptedKeyPair(pair);
        this.router.navigateByUrl('trading');
        // this.socketService.socketConnect();
    }

    logout() {
        this.socketService.disconnect();
        this.addressService.removeAllKeyPairs();
        this.router.navigateByUrl('login');
    }
}
