import { Injectable } from "@angular/core";
import { ActivatedRoute, Router } from "@angular/router";
import ltcUtils from '../../utils/litecore.util'
import { AddressService, IKeyPair } from "./address.service";

@Injectable({
    providedIn: 'root',
})

export class AuthService {
    constructor(
        private router: Router,
        private addressService: AddressService,
    ) {}

    get isLoggedIn() {
        return this.addressService.keyPairs.length > 0;
    }

    register(pass: string) {
        const pair = ltcUtils.generateRandomAddress() as IKeyPair;
        if (pair.address && pair.wifKey) {
            this.addressService.addDecryptedKeyPair(pair);
            this.router.navigateByUrl('trading');
        }
    }

    login(pair: IKeyPair) {
        this.addressService.addDecryptedKeyPair(pair);
        this.router.navigateByUrl('trading');
    }

    logout() {
        this.addressService.removeAllKeyPairs();
        this.router.navigateByUrl('login');
    }
}
