import { Injectable } from "@angular/core";
import { Router } from "@angular/router";
import { ToastrService } from "ngx-toastr";
import ltcUtils from '../../utils/litecore.util'
import { AddressService, IKeyPair } from "./address.service";
import { ApiService } from "./api.service";
import { BalanceService } from "./balance.service";
import { DialogService, DialogTypes } from "./dialogs.service";
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

    async loginFromPrivKey(privKey: string, pass: string) {
        console.log({privKey, pass});
        const res = await this.apiService.socketScriptApi.extractKeyPairFromPrivKey(privKey).toPromise();
        console.log({res});
    }

    async loginFromKeyFile(key: string, pass: string) {
        const res = ltcUtils.decryptKeyPair(key, pass) as IKeyPair[];

        if (!res?.length || !res[0]?.address || !res[0]?.pubKey || !res[0]?.privKey) {
            this.toastrService.error('Wrong Password or keyFile', 'Error');
            return;
        }
        const vaRes = await this.rpcService.rpc('validateaddress', [res[0].address]);

        if (vaRes.error || !vaRes.data) {
            this.toastrService.error('Error with validating wallet', 'Error');
            return;
        }

        if (!vaRes.data?.isvalid) {
            this.toastrService.error('The Address is not valid', 'Error');
            return;
        }

        if (vaRes.data?.isvalid && !vaRes.data?.ismine) {
            const ipkRes = await this.rpcService.rpc('importprivkey', [res[0].privKey, "tl-wallet", false]);
        }


        const luRes = await this.rpcService.rpc('listunspent', [0, 999999999, [res[0]?.address]]);
        const scLuRes: any = await this.apiService.soChainApi.getTxUnspents(res[0]?.address).toPromise()
        if (luRes.error || !luRes.data || scLuRes.status !== "success" || !scLuRes.data) {
            this.toastrService.error('Unexpecter Error. Please try again!', 'Error');
            return;
        }

        if (luRes.data.length !== scLuRes.data.txs?.length) {
            this.dialogService.openDialog(DialogTypes.RESCAN, { disableClose: false, data: { key, pass } });
            return;
        }

        this.login(res);
        this.encKey = ltcUtils.encryptKeyPair(this.addressService.keyPairs, pass);
        return;
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
