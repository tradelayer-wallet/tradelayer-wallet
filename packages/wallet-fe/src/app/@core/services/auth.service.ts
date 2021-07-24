import { Injectable } from "@angular/core";
import { Router } from "@angular/router";
import { ToastrService } from "ngx-toastr";
import ltcUtils from '../../utils/litecore.util'
import { AddressService, IKeyPair } from "./address.service";
import { ApiService } from "./api.service";
import { BalanceService } from "./balance.service";
import { DialogService, DialogTypes } from "./dialogs.service";
import { SocketService } from "./socket.service";
import { TxsService } from "./txs.service";

@Injectable({
    providedIn: 'root',
})

export class AuthService {
    public encKey: string = '';
    savedFromUrl: string = '';
    constructor(
        private router: Router,
        private addressService: AddressService,
        private dialogService: DialogService,
        private toastrService: ToastrService,
        private socketService: SocketService,
        private balanceService: BalanceService,
        private apiService: ApiService,
        private txsService: TxsService,
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
        this.fundAddress(pair.address);
    }

    private fundAddress(address: string) {
        this.apiService.fundingApi.fundAddress(address)
            .subscribe((res: any) => {
                res.error || !res.data
                    ? this.toastrService.error(res.error || 'Error with funding the address!')
                    : this.toastrService.success(res.data || `Address Funded!`);
            });
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
            if (Array.isArray(pair)) {
                pair.forEach((p: IKeyPair) => {
                    this.addressService.addDecryptedKeyPair(p);
                    this.balanceService.updateLtcBalanceForAddress(p.address);
                    this.balanceService.updateTokensBalanceForAddress(p.address)
                });
            } else {
                this.addressService.addDecryptedKeyPair(pair);
                this.balanceService.updateLtcBalanceForAddress(pair.address);
                this.balanceService.updateTokensBalanceForAddress(pair.address)
            }
        this.router.navigateByUrl(this.savedFromUrl);
        // this.socketService.socketConnect();
    }

    logout() {
        // this.socketService.disconnect();
        this.addressService.removeAllKeyPairs();
        this.balanceService.removeAllAddresses();
        this.txsService.pendingTxs = [];
        this.router.navigateByUrl('login');
    }
}
