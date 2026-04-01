import { Injectable } from "@angular/core";
import { ToastrService } from "ngx-toastr";
import { ApiService } from "./api.service";
import { AuthService } from "./auth.service";
import { BalanceService } from "./balance.service";
import { LoadingService } from "./loading.service";
import { RpcService, TNETWORK } from "./rpc.service";
import axios from 'axios'
import { ENCODER } from "src/app/utils/payloads/encoder";
import { ProceduralReceiptConfig } from "../constants/procedural.constants";

export interface IUTXO {
    amount: number;
    confirmations: number;
    scriptPubKey: string;
    redeemScript?: string;
    txid: string;
    vout: number;
};

export interface ISignTxConfig {
    rawtx: string;
    wif: string;
    inputs: IUTXO[];
}

export interface ISignPsbtConfig {
    wif: string;
    psbtHex: string;
}

export interface IBuildTxConfig {
    fromKeyPair: {
        address: string;
        pubkey?: string;
    },
    toKeyPair: {
        address: string;
        pubkey?: string;
    },
    inputs?: IUTXO[];
    amount?: number;
    payload?: string;
    addPsbt?: boolean;
    network?: TNETWORK;
}

export interface IBuildLTCITTxConfig {
    buyerKeyPair: {
        address: string;
        pubkey?: string;
    };
    sellerKeyPair: {
        address: string;
        pubkey?: string;
    };
    amount: number;
    payload: string;
    commitUTXOs: IUTXO[],
    network?: TNETWORK;
}

@Injectable({
    providedIn: 'root',
})

export class TxsService {
    constructor(
        private rpcService: RpcService,
        private apiService: ApiService,
        private authService: AuthService,
        private loadingService: LoadingService,
        private toastrService: ToastrService,
        private balanceService: BalanceService,
    ) { }

    get rpc() {
        return this.rpcService.rpc.bind(this);
    }

    get mainApi() {
        return this.apiService.mainApi;
    }

    get tlApi() {
        return this.apiService.tlApi;
    }

    async getWifByAddress(address: string) {
        return this.rpcService.rpc('dumpprivkey', [address]);
    }

    async getContractInfo(contractId: number) {
      const res = await axios.get(
        'http://localhost:3000/tl_getContractInfo',
        { params: { contractId } }
      );
      return res.data;
    }

    async getInitMarginPerContract(contractId: number, price: number) {
      const res = await axios.get(
        'http://localhost:3000/tl_getInitMargin',
        { params: { contractId, price } }
      );
      return Number(res.data);
    }


    async buildLTCITTx(
        buildTxConfig: IBuildLTCITTxConfig,
    ): Promise<{ data?: { rawtx: string; inputs: IUTXO[], psbtHex?: string }, error?: string }> {
        try {
            const network = this.rpcService.NETWORK;
            buildTxConfig.network = network;
            const isApiMode = this.rpcService.isApiMode;
            let result = await this.mainApi.buildLTCITTx(buildTxConfig, isApiMode).toPromise();
            return result;
        } catch (error: any) {
            return { error: error.message }
        }
    }

   // txs.service.ts
	async computeMultisig(
	  m: number,
	  pubKeys: string[]
	): Promise<{ data?: any; error?: string }> {
	  try {
		const network = this.rpcService.NETWORK ?? 'LTC';
	    const isApiMode = this.rpcService.isApiMode;

	    const result = await this.mainApi
	      .computeMultisig({ m, pubKeys, network }, isApiMode)
	      .toPromise();

	    return result;
	  } catch (e: any) {
	    return { error: e.message };
	  }
	}


   async buildTx(
        buildTxConfig: IBuildTxConfig
    ): Promise<{ data?: { rawtx: string; inputs: IUTXO[], psbtHex?: string }, error?: string }> {
        try {
            console.log('Inputs in build:', JSON.stringify(buildTxConfig));
            if (!buildTxConfig.inputs || buildTxConfig.inputs.length === 0) {
                console.log('error: No inputs available for building the transaction. Please ensure your address has UTXOs.');
            }

            const network = this.rpcService.NETWORK;
            buildTxConfig.network = network;
            const isApiMode = this.rpcService.isApiMode;
            let result = await this.mainApi.buildTx(buildTxConfig, isApiMode).toPromise();
            return result;
        } catch (error: any) {
            return { error: error.message || 'An unexpected error occurred while building the transaction.' }
        }
    }

    async buildSingSendTx(
            buildTxConfig: IBuildTxConfig,
        ): Promise<{ data?: string, error?: string }> {
            try {
                this.loadingService.isLoading = true;
                const buildRes = await this.buildTx(buildTxConfig);
                if (buildRes.error || !buildRes.data) {
                    return { error: buildRes.error || 'Failed to build the transaction.' };
                }

                const { inputs, rawtx } = buildRes.data;

                // if (!inputs || !rawtx) return { error: 'No inputs or raw transaction data available.' };
                // const keyPair = this.authService.listOfallAddresses.find(e => e.address === buildTxConfig.fromKeyPair.address);
                // if (!keyPair) return { error: `Could not find the keys for address: ${buildTxConfig.fromKeyPair.address}.` };
                // const wifRes = await this.rpcService.rpc('dumpprivkey', [buildTxConfig.fromKeyPair.address]);
                // if (!wifRes || wifRes.error) return { error: `Error with finding keys for address: ${buildTxConfig.fromKeyPair.address}.` };
                // const wif = wifRes.data;
                // const signRes = await this.signTx({ inputs, rawtx, wif });

                const signRes = await this.signRawTxWithWallet(rawtx);
                if (signRes.error || !signRes.data) {
                    return { error: signRes.error || 'Failed to sign the transaction.' };
                }

                const { isValid, signedHex } = signRes.data;
                if (!isValid || !signedHex) {
                    return { error: 'The transaction is not valid or could not be signed.' };
                }

                const sendRes = await this.sendTx(signedHex);
                if (sendRes.error || !sendRes.data) {
                    return { error: sendRes.error || 'Failed to broadcast the transaction.' };
                }

                return { data: sendRes.data };
            } catch (error: any) {
                console.log('was able to send despite err? ')
                this.toastrService.error(error.message);
                return { error: error.message };
            } finally {
                this.loadingService.isLoading = false;
                //this.balanceService.updateBalances();
            }
        }

    async signTx(signTxConfig: ISignTxConfig): Promise<{
        data?: {
            isValid: boolean,
            signedHex?: string,
            psbtHex?: string,
        },
        error?: string,
    }> {
        try {
            const network = this.rpcService.NETWORK;
            const result = await this.mainApi.signTx(signTxConfig, network).toPromise();
            return result;
        } catch (error: any) {
            return { error: error.message }
        }
    }

    async signRawTxWithWallet(txHex: string): Promise<{
        data: { isValid: boolean, signedHex?: string },
        error?: string
    }> {
        const result = await this.rpcService.rpc('signrawtransactionwithwallet', [txHex]);
        const data = { isValid: result.data.complete, signedHex: result.data.hex }
        return { data };
    }

    async signPsbt(signPsbtConfig: ISignPsbtConfig): Promise<{
        data?: {
            psbtHex: string;
            isValid: boolean;
            isFinished: boolean;
            finalHex?: string;
        },
        error?: string,
        debug?: string
    }> {
        try {
            const network = this.rpcService.NETWORK;
            console.log('network in sign psbt '+network+' '+JSON.stringify(network))
            const result = await this.mainApi.signPsbt(signPsbtConfig, network).toPromise();
            return result
        } catch (error: any) {
            return { error: error.message }
        }
    }

    // txs.service.ts (or wherever you call RPC)
     async finalizePsbt(psbtHex: string): Promise<{ data?: { finalHex?: string; complete?: boolean }, error?: string }> {
      try {
        // Core: finalizepsbt <psbt> true → { hex, complete }
        const res = await this.mainApi.rpcCall('finalizepsbt', [psbtHex, true]).toPromise();
        if (res?.error) return { error: res.error };
        return { data: { finalHex: res?.data?.hex, complete: !!res?.data?.complete } };
      } catch (e: any) {
        return { error: e?.message || String(e) };
      }
    }

    async sendTx(rawTx: string) {
        const result = await this.rpcService.rpc('sendrawtransaction', [rawTx]);
        //if(typeof this.balanceService.updateBalances==='function'){ 
        //console.log('checking balance service obj ' +JSON.stringify(this.balanceService)); // Check if balanceService is available        
        
        //this.balanceService.updateBalances();
        //}else{
        // console.log('update balances not found on balanceService')
        //}
        return result;
    }

    async depositToChannel(params: {
        fromAddress: string;
        channelAddress: string;
        propertyId: number;
        amount: number;
    }): Promise<{ data?: string; error?: string }> {
        const payload = ENCODER.encodeCommit({
            propertyId: params.propertyId,
            amount: params.amount,
            channelAddress: params.channelAddress,
        });

        return this.buildSingSendTx({
            fromKeyPair: { address: params.fromAddress },
            toKeyPair: { address: params.fromAddress },
            payload,
        });
    }

    async withdrawFromChannel(params: {
        fromAddress: string;
        channelAddress: string;
        propertyId: number;
        amount: number;
        withdrawAll?: boolean;
        column: number | boolean;
    }): Promise<{ data?: string; error?: string }> {
        const payload = ENCODER.encodeWithdrawal({
            withdrawAll: params.withdrawAll ? 1 : 0,
            propertyId: params.propertyId,
            amountOffered: params.amount,
            column: params.column,
            channelAddress: params.channelAddress,
        });

        return this.buildSingSendTx({
            fromKeyPair: { address: params.fromAddress },
            toKeyPair: { address: params.channelAddress },
            amount: 0.00000560,
            payload,
        });
    }

    async sendToken(params: {
        fromAddress: string;
        toAddress: string;
        propertyId: number;
        amount: number | string;
    }): Promise<{ data?: string; error?: string }> {
        const payload = ENCODER.encodeSend({
            sendAll: false,
            address: params.toAddress,
            propertyId: params.propertyId,
            amount: Number(params.amount),
        });

        return this.buildSingSendTx({
            fromKeyPair: { address: params.fromAddress },
            toKeyPair: { address: params.toAddress },
            payload,
        });
    }

    async issueProceduralToken(params: {
        adminAddress: string;
        ticker: string;
        initialAmount?: number | string;
        proceduralType: number;
        managed?: boolean;
        whitelists?: number[];
        backupAddress?: string;
    }): Promise<{ data?: string; error?: string }> {
        const payload = ENCODER.encodeTokenIssue({
            initialAmount: params.initialAmount || 0,
            ticker: params.ticker,
            whitelists: params.whitelists || [],
            managed: params.managed !== false,
            backupAddress: params.backupAddress || '',
            proceduralType: params.proceduralType,
        });

        return this.buildSingSendTx({
            fromKeyPair: { address: params.adminAddress },
            toKeyPair: { address: params.adminAddress },
            payload,
        });
    }

    async mintProceduralReceipt(params: {
        adminAddress: string;
        recipientAddress: string;
        redeemAddress?: string;
        propertyId: number;
        amount: number | string;
        dlcTemplateId?: string;
        dlcContractId?: string;
    }): Promise<{ data?: string; error?: string }> {
        const payload = ENCODER.encodeGrantManagedToken({
            propertyId: params.propertyId,
            amountGranted: params.amount,
            addressToGrantTo: params.recipientAddress,
            dlcTemplateId: params.dlcTemplateId,
            dlcContractId: params.dlcContractId,
        });

        return this.buildSingSendTx({
            fromKeyPair: { address: params.adminAddress },
            toKeyPair: { address: params.redeemAddress || params.recipientAddress },
            amount: 0.00000560,
            payload,
        });
    }

    async redeemProceduralReceipt(params: {
        holderAddress: string;
        propertyId: number;
        amount: number | string;
        dlcTemplateId?: string;
        dlcContractId?: string;
        settlementState?: string;
    }): Promise<{ data?: string; error?: string }> {
        const payload = ENCODER.encodeRedeemManagedToken({
            propertyId: params.propertyId,
            amountDestroyed: params.amount,
            dlcTemplateId: params.dlcTemplateId,
            dlcContractId: params.dlcContractId,
            settlementState: params.settlementState,
        });

        return this.buildSingSendTx({
            fromKeyPair: { address: params.holderAddress },
            toKeyPair: { address: params.holderAddress },
            payload,
        });
    }

    async tokenizeProceduralReceipt(params: {
        depositorAddress: string;
        amount: number | string;
        config: ProceduralReceiptConfig;
    }): Promise<{ data?: { depositTxid: string; mintTxid: string }; error?: string }> {
        const receiptPropertyId = Number(params.config.receiptPropertyId || 0);
        if (!receiptPropertyId) {
            return { error: 'Receipt property is not configured.' };
        }

        const mintRes = await this.mintProceduralReceipt({
            adminAddress: params.config.adminAddress,
            recipientAddress: params.depositorAddress,
            redeemAddress: params.config.vaultAddress,
            propertyId: receiptPropertyId,
            amount: params.amount,
            dlcTemplateId: params.config.templateId,
            dlcContractId: params.config.contractId,
        });

        if (mintRes.error || !mintRes.data) {
            return { error: mintRes.error || 'Failed to mint receipt token.' };
        }

        return { data: { depositTxid: mintRes.data, mintTxid: mintRes.data } };
    }

    async redeemProceduralReceiptWithRelease(params: {
        holderAddress: string;
        amount: number | string;
        config: ProceduralReceiptConfig;
        recipientAddress?: string;
    }): Promise<{ data?: { redeemTxid: string; releaseTxid: string }; error?: string }> {
        const receiptPropertyId = Number(params.config.receiptPropertyId || 0);
        if (!receiptPropertyId) {
            return { error: 'Receipt property is not configured.' };
        }

        const redeemRes = await this.redeemProceduralReceipt({
            holderAddress: params.holderAddress,
            propertyId: receiptPropertyId,
            amount: params.amount,
            dlcTemplateId: params.config.templateId,
            dlcContractId: params.config.contractId,
        });

        if (redeemRes.error || !redeemRes.data) {
            return { error: redeemRes.error || 'Failed to redeem receipt token.' };
        }

        const releaseRes = await this.sendToken({
            fromAddress: params.config.vaultAddress,
            toAddress: params.recipientAddress || params.holderAddress,
            propertyId: params.config.collateralPropertyId,
            amount: params.amount,
        });

        if (releaseRes.error || !releaseRes.data) {
            return { error: releaseRes.error || 'Failed to release collateral.' };
        }

        return { data: { redeemTxid: redeemRes.data, releaseTxid: releaseRes.data } };
    }

    async getChannel(address: string) {
        const channelRes = await this.tlApi.rpc('getChannel', [address]).toPromise();  // Pass address as an array
        console.log('channel fetch in tx service ' + JSON.stringify(channelRes))
        if (!channelRes.data || channelRes.error) return { data: [] };

        return channelRes.data;
    }


    async checkMempool(txid: string) {
        try {
            const mempool = await this.rpcService.rpc('getrawmempool', []);
            const isInMempool = mempool.data.includes(txid);


            return isInMempool;
        } catch (error) {
            console.error('Error checking mempool:', error);
            return false;
        }
    }

    async predictColumn(channelAddress: string, buyerAddress: string, cpAddress: string) {
        try {
            const column = await axios.post('http://localhost:3000/tl_getChannelColumn', { channelAddress, buyerAddress, cpAddress });
            console.log('column prediction fetch in tx service ' + JSON.stringify(column))

            return column.data;
        } catch (error) {
            console.error('Error checking column:', error);
            return false;
        }
    }


    async sendTxWithSpecRetry(rawTx: string) {
        const _sendTxWithRetry = async (rawTx: string, retriesLeft: number, ms: number): Promise<{
            data?: string,
            error?: string,
        }> => {
            const result = await this.rpcService.rpc('sendrawtransaction', [rawTx]);
            if (result.error && result.error.includes('bad-txns-inputs-missingorspent') && retriesLeft > 0) {
                await new Promise(resolve => setTimeout(resolve, ms));
                return _sendTxWithRetry(rawTx, retriesLeft - 1, ms);
            }
            return result;
        }
        return _sendTxWithRetry(rawTx, 15, 800);
    }

    async computeMargin(
      contractId: number,
      amount: number,
      price: number
    ) {
      const [contractInfo, perContractMargin] = await Promise.all([
        this.getContractInfo(contractId),
        this.getInitMarginPerContract(contractId, price),
      ]);

      if (!contractInfo || !perContractMargin) {
        throw new Error('Failed to compute futures margin');
      }

      const initMargin = perContractMargin * amount;
      const collateral = contractInfo.collateralPropertyId;

      if (!collateral || initMargin <= 0) {
        throw new Error('Invalid futures margin parameters');
      }

      return {
        collateral,
        initMargin,
        perContractMargin,
        inverse: contractInfo.inverse,
        leverage: contractInfo.leverage,
      };
    }

}

  
