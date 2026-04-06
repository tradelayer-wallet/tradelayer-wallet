import { Injectable } from "@angular/core";
import { ToastrService } from "ngx-toastr";
import { ApiService } from "./api.service";
import { AuthService } from "./auth.service";
import { BalanceService } from "./balance.service";
import { LoadingService } from "./loading.service";
import { RpcService, TNETWORK } from "./rpc.service";
import { ExplorerApiService } from "../apis/explorer-api.service";
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

export interface IBitvmDlcSetupResult {
    setupTxid: string;
    mintTxid: string;
    depositTxid?: string;
    setupId: string;
    fundingKeyAddress: string;
    operatorPubkey: string;
    fundingPubkey: string;
    templateId: string;
    templateHash: string;
    contractId: string;
    fundingAddress: string;
    operatorAddress: string;
    residualAddress: string;
    feeAddress?: string;
    pnlEscrowAddress?: string;
    refundAddress?: string;
    rolloverAddress?: string;
    routePlan?: any;
}

export interface IBitvmDlcOutputTarget {
    address: string;
    amount: number | string;
    label?: string;
}

export interface IBitvmDlcMultiOutputTxConfig {
    fromAddress: string;
    outputs: IBitvmDlcOutputTarget[];
    payload?: string;
    addPsbt?: boolean;
    network?: TNETWORK;
}

export interface IExpiryRedemptionArtifact {
    kind?: string;
    createdAt?: string;
    deposit?: {
        depositId?: string;
        accountId?: string;
        amountSats?: string;
        txid?: string;
    };
    redemption?: {
        redemptionId?: string;
        accountId?: string;
        amountSats?: string;
        remainingBalanceSats?: string;
    };
    deltas?: {
        kind?: string;
        epochId?: string;
        route?: string;
        depositedSats?: string;
        redeemedSats?: string;
        pnlReferenceSats?: string;
        realizedPnlSats?: string;
        pnlGainSats?: string;
        pnlLossSats?: string;
        feeSats?: string;
        netDeltaSats?: string;
        maturityHeight?: string;
        expiryHeight?: string | null;
        oracleEventId?: string;
        oracleDigestHex?: string;
        note?: string;
        annotationHash?: string;
        settlementBreakdown?: {
            kind?: string;
            version?: number;
            epochId?: string;
            route?: string;
            settlementKind?: string;
            collateralSats?: string;
            redeemedSats?: string;
            winnerSweepSats?: string;
            pnlReferenceSats?: string;
            realizedPnlSats?: string;
            winnerPnlSats?: string;
            loserPnlSats?: string;
            feeSats?: string;
            refundSats?: string;
            residualSats?: string;
            rolloverCollateralSats?: string;
            dustCarrySats?: string;
            refundRecipient?: string | null;
            winnerRecipient?: string | null;
            netSettlementSats?: string;
            note?: string | null;
        };
    };
    settlementBreakdown?: {
        kind?: string;
        version?: number;
        epochId?: string;
        route?: string;
        settlementKind?: string;
        collateralSats?: string;
        redeemedSats?: string;
        winnerSweepSats?: string;
        pnlReferenceSats?: string;
        realizedPnlSats?: string;
        winnerPnlSats?: string;
        loserPnlSats?: string;
        feeSats?: string;
        refundSats?: string;
        residualSats?: string;
        rolloverCollateralSats?: string;
        dustCarrySats?: string;
        refundRecipient?: string | null;
        winnerRecipient?: string | null;
        netSettlementSats?: string;
        note?: string | null;
    };
    routingCommitments?: {
        winnerRole?: string | null;
        winnerAddress?: string | null;
        refundRole?: string | null;
        refundAddress?: string | null;
        feeRole?: string | null;
        feeAddress?: string | null;
        dustRole?: string | null;
        dustAddress?: string | null;
    };
    witnessBlob?: {
        committed?: Record<string, any>;
        deltaAnnotation?: Record<string, any>;
        witnessBlobHash?: string;
    };
    artifactHash?: string;
}

@Injectable({
    providedIn: 'root',
})

export class TxsService {
    constructor(
        private rpcService: RpcService,
        private apiService: ApiService,
        private explorerApi: ExplorerApiService,
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

    async buildBitvmDlcTx(
        buildTxConfig: IBitvmDlcMultiOutputTxConfig
    ): Promise<{ data?: { rawtx: string; inputs: IUTXO[]; outputs?: Record<string, number>; psbtHex?: string }, error?: string }> {
        try {
            const network = this.rpcService.NETWORK;
            buildTxConfig.network = network;
            const isApiMode = this.rpcService.isApiMode;
            const result = await this.mainApi.buildBitvmDlcTx(buildTxConfig, isApiMode).toPromise();
            return result;
        } catch (error: any) {
            return { error: error.message || 'An unexpected error occurred while building the BitVM DLC transaction.' };
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

    async waitForTxConfirmations(txid: string, minConfirmations = 1, timeoutMs = 5 * 60 * 1000): Promise<{ data?: number; error?: string }> {
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
            try {
                const txRes = await this.rpcService.rpc('gettransaction', [txid]);
                const confirmations = Number(txRes?.data?.confirmations || 0);
                if (confirmations >= minConfirmations) {
                    return { data: confirmations };
                }
            } catch (error: any) {
                const msg = String(error?.message || error || '').toLowerCase();
                if (!msg.includes('not found')) {
                    return { error: error?.message || String(error) };
                }
            }
            await new Promise((resolve) => setTimeout(resolve, 5000));
        }
        return { error: `Timed out waiting for ${minConfirmations} confirmation(s) on ${txid}` };
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

    async redeemBitvmFundingOutput(params: {
        fundingAddress: string;
        recipientAddress: string;
        amount?: number | string;
        residualAddress?: string;
        artifact?: IExpiryRedemptionArtifact;
        payload?: string;
    }): Promise<{ data?: string; error?: string }> {
        const fundingAddress = String(params.fundingAddress || '').trim();
        const recipientAddress = String(params.recipientAddress || '').trim();
        const residualAddress = String(params.residualAddress || fundingAddress || '').trim();
        if (!fundingAddress) {
            return { error: 'Funding address is required for BitVM redemption.' };
        }
        if (!recipientAddress) {
            return { error: 'Recipient address is required for BitVM redemption.' };
        }

        const utxoRes = await this.rpcService.rpc('listunspent', [1, 9999999, [fundingAddress]]);
        if (utxoRes.error || !Array.isArray(utxoRes.data) || utxoRes.data.length === 0) {
            return { error: `No confirmed funding UTXO found for ${fundingAddress}` };
        }

        const inputAmount = utxoRes.data.reduce((sum: number, utxo: any) => {
            return sum + Number(utxo?.amount || 0);
        }, 0);
        if (!Number.isFinite(inputAmount) || inputAmount <= 0) {
            return { error: 'Invalid BitVM funding UTXO amount.' };
        }

        const estimatedFee = Number((0.2 * 0.00015).toFixed(8));
        const routingOutputs = params.artifact
            ? this.buildArtifactRedemptionOutputs({
                artifact: params.artifact,
                inputAmount,
                estimatedFee,
                fallbackRecipientAddress: recipientAddress,
                fallbackResidualAddress: residualAddress,
            })
            : null;
        if (routingOutputs?.error) {
            return { error: routingOutputs.error };
        }
        let outputs: IBitvmDlcOutputTarget[] | null = routingOutputs?.outputs || null;
        if (!outputs) {
            const spendAmount = Number(
                params.amount != null ? params.amount : Number((inputAmount - estimatedFee).toFixed(8))
            );
            if (!Number.isFinite(spendAmount) || spendAmount <= 0) {
                return { error: 'Invalid BitVM payout amount.' };
            }
            const residualAmount = Number((inputAmount - spendAmount - estimatedFee).toFixed(8));
            if (residualAmount < -0.00000001) {
                return { error: 'BitVM funding UTXO is too small for the requested payout and fees.' };
            }
            const legacyOutputs: IBitvmDlcOutputTarget[] = [
                { address: recipientAddress, amount: spendAmount, label: 'payout' },
            ];
            if (residualAmount > 0) {
                legacyOutputs.push({
                    address: residualAddress,
                    amount: residualAmount,
                    label: 'residual',
                });
            }
            outputs = legacyOutputs;
        }

        const outputTargets = outputs || [];
        if (!outputTargets.length) {
            return { error: 'No BitVM redemption outputs were produced.' };
        }

        const buildRes = await this.buildBitvmDlcTx({
            fromAddress: fundingAddress,
            outputs: outputTargets,
            payload: params.payload,
        });

        if (buildRes.error || !buildRes.data?.rawtx) {
            return { error: buildRes.error || 'Failed to build BitVM redemption tx.' };
        }

        const signRes = await this.signRawTxWithWallet(buildRes.data.rawtx);
        if (signRes.error || !signRes.data) {
            return { error: signRes.error || 'Failed to sign BitVM redemption tx.' };
        }

        const { isValid, signedHex } = signRes.data;
        if (!isValid || !signedHex) {
            return { error: 'BitVM redemption tx is not valid or could not be signed.' };
        }

        const sendRes = await this.sendTx(signedHex);
        if (sendRes.error || !sendRes.data) {
            return { error: sendRes.error || 'Failed to broadcast BitVM redemption tx.' };
        }

        return { data: sendRes.data };
    }

    private satsToLtcNumber(sats: string | number | undefined | null) {
        const value = Number(sats || 0);
        if (!Number.isFinite(value) || value <= 0) return 0;
        return Number((value / 1e8).toFixed(8));
    }

    private toSatsInt(value: string | number | undefined | null) {
        const n = Number(value || 0);
        if (!Number.isFinite(n) || n <= 0) return 0;
        return Math.max(0, Math.round(n));
    }

    private buildArtifactRedemptionOutputs(params: {
        artifact: IExpiryRedemptionArtifact;
        inputAmount: number;
        estimatedFee: number;
        fallbackRecipientAddress: string;
        fallbackResidualAddress: string;
    }): { outputs?: IBitvmDlcOutputTarget[]; error?: string } {
        const artifact = params.artifact;
        const settlement = artifact?.settlementBreakdown
            || artifact?.deltas?.settlementBreakdown
            || artifact?.witnessBlob?.deltaAnnotation?.settlementBreakdown
            || {};
        const routing = artifact?.routingCommitments || {};
        const inputSats = this.toSatsInt(Math.round(params.inputAmount * 1e8));
        const estimatedFeeSats = this.toSatsInt(Math.round(params.estimatedFee * 1e8));
        const winnerSats = this.toSatsInt(settlement?.winnerSweepSats || artifact?.redemption?.amountSats);
        let refundSats = this.toSatsInt(settlement?.refundSats || settlement?.residualSats || artifact?.redemption?.remainingBalanceSats);
        let feeSats = this.toSatsInt(settlement?.feeSats);
        let dustSats = this.toSatsInt(settlement?.dustCarrySats);

        const winnerAddress = String(routing?.winnerAddress || params.fallbackRecipientAddress || '').trim();
        const refundAddress = String(routing?.refundAddress || params.fallbackResidualAddress || '').trim();
        const feeAddress = String(routing?.feeAddress || params.fallbackResidualAddress || '').trim();
        const dustAddress = String(routing?.dustAddress || '').trim();

        if (!winnerAddress) {
            return { error: 'Missing committed winner address for artifact-backed BitVM release.' };
        }
        if (refundSats > 0 && !refundAddress) {
            return { error: 'Missing committed refund address for artifact-backed BitVM release.' };
        }
        if (feeSats > 0 && !feeAddress) {
            return { error: 'Missing committed fee address for artifact-backed BitVM release.' };
        }
        if (dustSats > 0 && !dustAddress) {
            return { error: 'Missing committed dust address for artifact-backed BitVM release.' };
        }

        const committedTotal = winnerSats + refundSats + feeSats + dustSats;
        if (committedTotal <= 0) {
            return { error: 'Artifact-backed BitVM release produced no spendable outputs.' };
        }
        if (committedTotal > inputSats) {
            return { error: `Artifact outputs exceed funding input: committed=${committedTotal} sats input=${inputSats} sats` };
        }

        let feeToAbsorb = Math.max(0, committedTotal + estimatedFeeSats - inputSats);
        const absorb = (current: number) => {
            const next = Math.max(0, current - feeToAbsorb);
            feeToAbsorb = Math.max(0, feeToAbsorb - current);
            return next;
        };
        refundSats = absorb(refundSats);
        dustSats = absorb(dustSats);
        feeSats = absorb(feeSats);
        if (feeToAbsorb > 0) {
            return { error: 'Committed settlement outputs do not leave enough flexible remainder to pay the miner fee.' };
        }

        const outputs: IBitvmDlcOutputTarget[] = [];
        if (winnerSats > 0) {
            outputs.push({ address: winnerAddress, amount: this.satsToLtcNumber(winnerSats), label: 'winner-sweep' });
        }
        if (refundSats > 0) {
            outputs.push({ address: refundAddress, amount: this.satsToLtcNumber(refundSats), label: 'refund' });
        }
        if (feeSats > 0) {
            outputs.push({ address: feeAddress, amount: this.satsToLtcNumber(feeSats), label: 'fee' });
        }
        if (dustSats > 0) {
            outputs.push({ address: dustAddress, amount: this.satsToLtcNumber(dustSats), label: 'dust' });
        }

        return { outputs };
    }

    private buildExpiryRedemptionPayload(artifact: IExpiryRedemptionArtifact, fallbackAmountSats: string | number) {
        const delta = artifact?.deltas || artifact?.witnessBlob?.deltaAnnotation || {};
        const settlement = artifact?.settlementBreakdown
            || artifact?.deltas?.settlementBreakdown
            || artifact?.witnessBlob?.deltaAnnotation?.settlementBreakdown
            || {};
        const routing = artifact?.routingCommitments || {};
        return JSON.stringify({
            kind: artifact?.kind || 'm1_expiry_redemption',
            artifactHash: artifact?.artifactHash || null,
            redemptionId: artifact?.redemption?.redemptionId || null,
            depositId: artifact?.deposit?.depositId || null,
            epochId: delta?.epochId || null,
            route: delta?.route || null,
            depositedSats: String(delta?.depositedSats || artifact?.deposit?.amountSats || '0'),
            redeemedSats: String(delta?.redeemedSats || artifact?.redemption?.amountSats || fallbackAmountSats || '0'),
            pnlGainSats: String(delta?.pnlGainSats || '0'),
            pnlLossSats: String(delta?.pnlLossSats || '0'),
            netDeltaSats: String(delta?.netDeltaSats || '0'),
            annotationHash: String(delta?.annotationHash || artifact?.witnessBlob?.deltaAnnotation?.annotationHash || ''),
            routingCommitments: {
                winnerRole: String(routing?.winnerRole || ''),
                winnerAddress: String(routing?.winnerAddress || ''),
                refundRole: String(routing?.refundRole || ''),
                refundAddress: String(routing?.refundAddress || ''),
                feeRole: String(routing?.feeRole || ''),
                feeAddress: String(routing?.feeAddress || ''),
                dustRole: String(routing?.dustRole || ''),
                dustAddress: String(routing?.dustAddress || ''),
            },
            settlementBreakdown: {
                kind: String(settlement?.kind || 'settlement-breakdown'),
                settlementKind: String(settlement?.settlementKind || delta?.route || 'roll'),
                winnerSweepSats: String(settlement?.winnerSweepSats || delta?.redeemedSats || artifact?.redemption?.amountSats || fallbackAmountSats || '0'),
                refundSats: String(settlement?.refundSats || artifact?.redemption?.remainingBalanceSats || '0'),
                residualSats: String(settlement?.residualSats || artifact?.redemption?.remainingBalanceSats || '0'),
                dustCarrySats: String(settlement?.dustCarrySats || '0'),
                winnerPnlSats: String(settlement?.winnerPnlSats || delta?.pnlGainSats || '0'),
                loserPnlSats: String(settlement?.loserPnlSats || delta?.pnlLossSats || '0')
            }
        });
    }

    async redeemProceduralReceiptWithExpiryArtifact(params: {
        holderAddress: string;
        amount?: number | string;
        config: ProceduralReceiptConfig;
        recipientAddress?: string;
        artifactName?: string;
    }): Promise<{ data?: { redeemTxid: string; releaseTxid: string; artifact?: IExpiryRedemptionArtifact }; error?: string }> {
        const receiptPropertyId = Number(params.config.receiptPropertyId || 0);
        if (!receiptPropertyId) {
            return { error: 'Receipt property is not configured.' };
        }

        const artifactName = String(params.artifactName || params.config.expiryArtifactName || 'm1_expiry_redemption_latest.json').trim();
        const artifactRes = await this.explorerApi.artifact(artifactName).toPromise();
        const artifact = artifactRes?.content as IExpiryRedemptionArtifact | undefined;
        if (!artifact || artifact.kind !== 'm1_expiry_redemption') {
            return { error: `Expiry redemption artifact not found or invalid: ${artifactName}` };
        }

        const redemptionAmountSats = artifact?.redemption?.amountSats
            || artifact?.deltas?.redeemedSats
            || artifact?.witnessBlob?.deltaAnnotation?.redeemedSats
            || '';
        const redemptionAmount = this.satsToLtcNumber(redemptionAmountSats) || Number(params.amount || 0);
        if (!Number.isFinite(redemptionAmount) || redemptionAmount <= 0) {
            return { error: 'Invalid redemption amount in expiry artifact.' };
        }

        const redeemRes = await this.redeemProceduralReceipt({
            holderAddress: params.holderAddress,
            amount: redemptionAmount,
            config: params.config,
        });

        if (redeemRes.error || !redeemRes.data?.redeemTxid) {
            return { error: redeemRes.error || 'Failed to redeem receipt token.' };
        }

        const redeemWait = await this.waitForTxConfirmations(redeemRes.data.redeemTxid, 1);
        if (redeemWait.error) {
            return { error: redeemWait.error };
        }

        const releaseRes = await this.redeemBitvmFundingOutput({
            fundingAddress: params.config.fundingAddress,
            recipientAddress: params.recipientAddress || params.holderAddress,
            amount: redemptionAmount,
            residualAddress: params.config.residualAddress || params.config.vaultAddress || params.config.adminAddress,
            artifact,
            payload: this.buildExpiryRedemptionPayload(artifact, redemptionAmountSats),
        });

        if (releaseRes.error || !releaseRes.data) {
            return { error: releaseRes.error || 'Failed to release collateral.' };
        }

        return {
            data: {
                redeemTxid: redeemRes.data.redeemTxid,
                releaseTxid: releaseRes.data,
                artifact
            }
        };
    }

    async buildBitvmFundingTx(params: {
        fromAddress: string;
        fundingAddress: string;
        feeAddress?: string;
        pnlEscrowAddress?: string;
        fundingAmount: number | string;
        feeAmount?: number | string;
        pnlEscrowAmount?: number | string;
        payload?: string;
    }): Promise<{ data?: string; error?: string }> {
        const outputs: IBitvmDlcOutputTarget[] = [];
        const fundingAmount = Number(params.fundingAmount || 0);
        const feeAmount = Number(params.feeAmount || 0);
        const pnlEscrowAmount = Number(params.pnlEscrowAmount || 0);
        if (fundingAmount > 0) {
            outputs.push({ address: params.fundingAddress, amount: fundingAmount, label: 'contract-funding' });
        }
        if (feeAmount > 0 && params.feeAddress) {
            outputs.push({ address: params.feeAddress, amount: feeAmount, label: 'fee' });
        }
        if (pnlEscrowAmount > 0 && params.pnlEscrowAddress) {
            outputs.push({ address: params.pnlEscrowAddress, amount: pnlEscrowAmount, label: 'pnl-escrow' });
        }

        const buildRes = await this.buildBitvmDlcTx({
            fromAddress: params.fromAddress,
            outputs,
            payload: params.payload,
        });

        if (buildRes.error || !buildRes.data?.rawtx) {
            return { error: buildRes.error || 'Failed to build BitVM funding tx.' };
        }

        const signRes = await this.signRawTxWithWallet(buildRes.data.rawtx);
        if (signRes.error || !signRes.data) {
            return { error: signRes.error || 'Failed to sign BitVM funding tx.' };
        }

        const { isValid, signedHex } = signRes.data;
        if (!isValid || !signedHex) {
            return { error: 'BitVM funding tx is not valid or could not be signed.' };
        }

        const sendRes = await this.sendTx(signedHex);
        if (sendRes.error || !sendRes.data) {
            return { error: sendRes.error || 'Failed to broadcast BitVM funding tx.' };
        }

        return { data: sendRes.data };
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
        fundingAddress?: string;
        propertyId: number;
        amount: number | string;
        dlcTemplateId?: string;
        dlcContractId?: string;
        config: ProceduralReceiptConfig;
        routePlan?: any;
    }): Promise<{ data?: string; error?: string }> {
        const fundingAmount = Number(params.amount);
        if (!Number.isFinite(fundingAmount) || fundingAmount <= 0) {
            return { error: 'Procedural funding amount must be greater than zero.' };
        }

        const senderAddress = params.recipientAddress || params.adminAddress;
        const tokenRecipientAddress = params.fundingAddress || params.recipientAddress;
        const dlcHash = params.config.dlcHash;
        const payload = ENCODER.encodeGrantManagedToken({
            propertyId: params.propertyId,
            amountGranted: params.amount,
            addressToGrantTo: tokenRecipientAddress,
            dlcTemplateId: params.dlcTemplateId,
            dlcContractId: params.dlcContractId,
            settlementState: 'FUNDED',
            dlcHash,
        });

        const routePlan = params.routePlan || params.config.routePlan;
        if (routePlan?.outputs?.length) {
            const outputAmountMap = routePlan.outputs.map((out: any) => ({
                address: String(out.address || tokenRecipientAddress),
                amount: Number(out.amountLtc || out.amount || 0),
                label: String(out.role || ''),
            }));
            const buildRes = await this.buildBitvmDlcTx({
                fromAddress: senderAddress,
                outputs: outputAmountMap,
                payload,
            });
            if (buildRes.error || !buildRes.data?.rawtx) {
                return { error: buildRes.error || 'Failed to build BitVM funding tx.' };
            }
            const signRes = await this.signRawTxWithWallet(buildRes.data.rawtx);
            if (signRes.error || !signRes.data) {
                return { error: signRes.error || 'Failed to sign BitVM funding tx.' };
            }
            const { isValid, signedHex } = signRes.data;
            if (!isValid || !signedHex) {
                return { error: 'BitVM funding tx is not valid or could not be signed.' };
            }
            const sendRes = await this.sendTx(signedHex);
            if (sendRes.error || !sendRes.data) {
                return { error: sendRes.error || 'Failed to broadcast BitVM funding tx.' };
            }
            return { data: sendRes.data };
        }

        return this.buildSingSendTx({
            fromKeyPair: { address: senderAddress },
            toKeyPair: { address: tokenRecipientAddress },
            amount: fundingAmount,
            payload,
        });
    }

    async redeemProceduralReceipt(params: {
        holderAddress: string;
        propertyId?: number;
        amount: number | string;
        dlcTemplateId?: string;
        dlcContractId?: string;
        config?: ProceduralReceiptConfig;
    }): Promise<{ data?: { redeemTxid: string }; error?: string }> {
        const receiptPropertyId = Number(
            params.propertyId || params.config?.receiptPropertyId || 0
        );
        if (!receiptPropertyId) {
            return { error: 'Receipt property is not configured.' };
        }

        const payload = ENCODER.encodeRedeemManagedToken({
            propertyId: receiptPropertyId,
            amountDestroyed: params.amount,
            dlcTemplateId: params.dlcTemplateId || params.config?.templateId,
            dlcContractId: params.dlcContractId || params.config?.contractId,
        });

        const result = await this.buildSingSendTx({
            fromKeyPair: { address: params.holderAddress },
            toKeyPair: { address: params.holderAddress },
            payload,
        });

        if (result.error || !result.data) {
            return { error: result.error || 'Failed to redeem receipt token.' };
        }

        return { data: { redeemTxid: result.data } };
    }

    async createBitvmDlcSetup(params: {
        depositorAddress: string;
        amount: number | string;
        config: ProceduralReceiptConfig;
    }): Promise<{ data?: IBitvmDlcSetupResult; error?: string }> {
        const receiptPropertyId = Number(params.config.receiptPropertyId || 0);
        if (!receiptPropertyId) {
            return { error: 'Receipt property is not configured.' };
        }

        const setupRes = await this.mainApi.buildBitvmDlcSetup({
            adminAddress: params.config.adminAddress,
            depositorAddress: params.depositorAddress,
            amount: params.amount,
            templateId: params.config.templateId,
            templateHash: params.config.dlcHash,
            contractId: params.config.contractId,
            vaultAddress: params.config.vaultAddress,
            feeAddress: params.config.feeAddress,
            pnlEscrowAddress: params.config.pnlEscrowAddress,
            refundAddress: params.config.refundAddress,
            rolloverAddress: params.config.rolloverAddress,
            flatRecipientAddress: params.config.flatRecipientAddress,
            pnlRecipientAddress: params.config.pnlRecipientAddress,
            feeRateBps: params.config.feeRateBps,
            pnlEscrowBps: params.config.pnlEscrowBps,
            settlementSplitBps: params.config.settlementSplitBps,
            walletLabel: this.authService.walletLabel,
            network: this.rpcService.NETWORK || 'LTCTEST',
        }, this.rpcService.isApiMode).toPromise();

        if (setupRes?.error || !setupRes?.data) {
            return { error: setupRes?.error || 'Failed to build BitVM DLC setup.' };
        }

        const mintRes = await this.mintProceduralReceipt({
            adminAddress: params.config.adminAddress,
            recipientAddress: params.depositorAddress,
            fundingAddress: setupRes.data.fundingAddress,
            propertyId: receiptPropertyId,
            amount: params.amount,
            dlcTemplateId: setupRes.data.templateId,
            dlcContractId: setupRes.data.contractId,
            routePlan: setupRes.data.routePlan,
            config: params.config,
        });

        if (mintRes.error || !mintRes.data) {
            return { error: mintRes.error || 'Failed to mint receipt token.' };
        }

        const mintWait = await this.waitForTxConfirmations(mintRes.data, 1);
        if (mintWait.error) {
            return { error: mintWait.error };
        }

        return {
            data: {
                setupTxid: mintRes.data,
                mintTxid: mintRes.data,
                setupId: setupRes.data.setupId,
                fundingKeyAddress: setupRes.data.fundingKeyAddress,
                operatorPubkey: setupRes.data.operatorPubkey,
                fundingPubkey: setupRes.data.fundingPubkey,
                templateId: setupRes.data.templateId,
                templateHash: setupRes.data.templateHash,
                contractId: setupRes.data.contractId,
                fundingAddress: setupRes.data.fundingAddress,
                operatorAddress: setupRes.data.operatorAddress,
                residualAddress: setupRes.data.residualAddress,
                feeAddress: setupRes.data.feeAddress,
                pnlEscrowAddress: setupRes.data.pnlEscrowAddress,
                refundAddress: setupRes.data.refundAddress,
                rolloverAddress: setupRes.data.rolloverAddress,
                routePlan: setupRes.data.routePlan,
            }
        };
    }

    async tokenizeProceduralReceipt(params: {
        depositorAddress: string;
        amount: number | string;
        config: ProceduralReceiptConfig;
    }): Promise<{ data?: IBitvmDlcSetupResult; error?: string }> {
        return this.createBitvmDlcSetup(params);
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
            amount: params.amount,
            config: params.config,
        });

        if (redeemRes.error || !redeemRes.data?.redeemTxid) {
            return { error: redeemRes.error || 'Failed to redeem receipt token.' };
        }

        const redeemWait = await this.waitForTxConfirmations(redeemRes.data.redeemTxid, 1);
        if (redeemWait.error) {
            return { error: redeemWait.error };
        }

        const releaseRes = await this.redeemBitvmFundingOutput({
            fundingAddress: params.config.fundingAddress,
            recipientAddress: params.recipientAddress || params.holderAddress,
            amount: params.amount,
            residualAddress: params.config.residualAddress || params.config.vaultAddress || params.config.adminAddress,
        });

        if (releaseRes.error || !releaseRes.data) {
            return { error: releaseRes.error || 'Failed to release collateral.' };
        }

        return { data: { redeemTxid: redeemRes.data.redeemTxid, releaseTxid: releaseRes.data } };
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

  
