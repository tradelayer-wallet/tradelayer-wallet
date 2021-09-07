import { Injectable } from "@angular/core";
import { Router } from "@angular/router";
import { ToastrService } from "ngx-toastr";
import ltcUtils from '../../utils/litecore.util'
import { AddressService, IKeyPair } from "./address.service";
import { ApiService } from "./api.service";
import { BalanceService } from "./balance.service";
import { DialogService } from "./dialogs.service";
import { RpcService } from "./rpc.service";
import { TxsService } from "./spot-services/txs.service";

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
        private balanceService: BalanceService,
        private apiService: ApiService,
        private txsService: TxsService,
        private rpcService: RpcService,
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

    async loginFromKeyFile(key: string, pass: string) {
        const res = ltcUtils.decryptKeyPair(key, pass) as IKeyPair[];
        if (res?.length && res[0].address && res[0].pubKey && res[0].privKey) {
            const vaRes = await this.rpcService.rpc('validateaddress', [res[0].address]);
            if (vaRes.error || !vaRes.data?.ismine) {
                this.toastrService.error('This wallet is not accessible', 'Error');
            } else {
                this.login(res);
                this.encKey = ltcUtils.encryptKeyPair(this.addressService.keyPairs, pass);
            }
        } else {
            this.toastrService.error('Wrong Password or keyFile', 'Error');
        }
    }

    login(pair: IKeyPair | IKeyPair[]) {
            if (Array.isArray(pair)) {
                pair.forEach((p: IKeyPair) => {
                    this.addressService.addDecryptedKeyPair(p);
                    this.balanceService.updateBalances(p.address);
                });
            } else {
                this.addressService.addDecryptedKeyPair(pair);
                this.balanceService.updateBalances(pair.address);
            }
        this.router.navigateByUrl(this.savedFromUrl);
    }

    logout() {
        this.addressService.removeAllKeyPairs();
        this.balanceService.restartBalance();
        this.txsService.pendingTxs = [];
        this.router.navigateByUrl('login');
    }
}
