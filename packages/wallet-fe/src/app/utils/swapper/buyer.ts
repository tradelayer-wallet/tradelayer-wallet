import { Socket as SocketClient } from 'socket.io-client';
import { IBuildLTCITTxConfig, IUTXO, TxsService } from "src/app/@core/services/txs.service";
import { decodePsbt, IBuyerSellerInfo, IFuturesTradeProps, IMSChannelData, ISpotTradeProps, ETradeType, TClient } from "./common";
import { Swap } from "./swap";
import { channelWitnessScript, psbtTxid, TRADE_EXPIRY_BLOCKS } from "./psbt-guard";
import { ICommitUtxo, ISwapRelay, TSwapEventData } from "./protocol";
import { satsToLtc, unitsToDecimal } from "../units";

export class BuySwapper extends Swap {
    // Txid of the unsigned transaction this wallet built in BUYER:STEP4. The PSBT the seller returns
    // must carry this same txid, or it is not signed. The txid does not depend on signatures, so it is
    // also the txid of the transaction this wallet broadcasts.
    private expectedTxid: string | null = null;

    constructor(
        sessionId: string,
        typeTrade: ETradeType,
        tradeInfo: IFuturesTradeProps | ISpotTradeProps,
        buyerInfo: IBuyerSellerInfo,
        sellerInfo: IBuyerSellerInfo,
        client: TClient,
        socket: SocketClient,
        txsService: TxsService,
    ) {
        super(sessionId, typeTrade, tradeInfo, buyerInfo, sellerInfo, client, socket, txsService);
    }

    protected outcomeTxid(): string | null {
        return this.expectedTxid;
    }

    // Sends the PSBT this wallet built, after recording the txid it must come back with.
    private async sendPsbtToSeller(psbtHex: string) {
        const decRes = await decodePsbt(this.client, psbtHex);
        const txid = decRes.error ? null : psbtTxid(decRes.data);
        if (!txid) throw new Error(`decodepsbt: ${decRes.error}`);
        this.expectedTxid = txid;
        this.emitSwapEvent('BUYER:STEP4', psbtHex);
    }

    protected handleSwapEvent(event: ISwapRelay & { socketId: string }) {
        const { socketId, data } = event;
        switch (event.eventName) {
            case 'SELLER:STEP1':
                this.onStep1(socketId, data as TSwapEventData['SELLER:STEP1']);
                break;
            case 'SELLER:STEP3':
                this.onStep3(socketId, data as ICommitUtxo);
                break;
            case 'SELLER:STEP5':
                this.onStep5(socketId, data as string);
                break;
            default:
                break;
        }
    }

    private async onStep1(cpId: string, msData: IMSChannelData) {
        try {
            if (cpId !== this.cpInfo.socketId) throw new Error(`Error with p2p connection`);
            const pubKeys = [this.cpInfo.keypair.pubkey, this.myInfo.keypair.pubkey];
            const amaRes = await this.client("addmultisigaddress", [2, pubKeys]);
            if (amaRes.error || !amaRes.data) throw new Error(`addmultisigaddress: ${amaRes.error}`);
            if (amaRes.data.redeemScript !== msData.redeemScript) throw new Error(`redeemScript of Multysig is not matching`);
            // The commit is paid to the channel at step 3. The redeem script above is the 2-of-2 this
            // node derived from the keys. The counterparty's address is accepted only if its script is
            // the P2WSH of that redeem script. The address string is not compared: two nodes with
            // different address-type settings encode the same script differently. A P2SH-wrapped
            // channel is refused here, before any commit is broadcast, because the commit input
            // cannot be signed in that form.
            const vaRes = await this.client('validateaddress', [msData.address]);
            if (vaRes.error) throw new Error(`validateaddress: ${vaRes.error}`);
            // No script means the address is not valid on this network: the same refusal as a wrong script.
            const scriptPubKey = typeof vaRes.data?.scriptPubKey === 'string' ? vaRes.data.scriptPubKey.toLowerCase() : '';
            if (!scriptPubKey || scriptPubKey !== channelWitnessScript(amaRes.data.redeemScript)) {
                throw new Error(`address of Multysig is not matching`);
            }
            this.multySigChannelData = {
                address: msData.address,
                redeemScript: amaRes.data.redeemScript,
                scriptPubKey,
            };
            this.emitSwapEvent('BUYER:STEP2');
        } catch (error: any) {
            const errorMessge = error.message || 'Undefined Error';
            this.terminateTrade(`Step 1: ${errorMessge}`);
        }
    }

    // The commit output the seller reports, in the LTC form the transaction builder takes.
    private commitAsUtxo(commit: ICommitUtxo): IUTXO {
        return {
            txid: commit.txid, vout: commit.vout, amount: satsToLtc(commit.sats),
            scriptPubKey: commit.scriptPubKey, redeemScript: commit.redeemScript,
        } as IUTXO;
    }

    private async onStep3(cpId: string, commit: ICommitUtxo) {
        try {
            if (cpId !== this.cpInfo.socketId) throw new Error(`Error with p2p connection`);
            if (!this.multySigChannelData) throw new Error(`Wrong Multisig Data Provided`);
            // Refuse an unmodelled trade before any commit is built or broadcast. The seller applies the same rule.
            if (!this.isModelledTrade() || !('propIdDesired' in this.tradeInfo)) throw new Error(`trade not modelled: refusing before commit`);
            const { propIdDesired, amountDesired, amountForSale } = this.tradeInfo;
            const commitUTXO = this.commitAsUtxo(commit);
            const tlgiRes = await this.client('tl_getinfo');
            if (tlgiRes.error || !tlgiRes.data?.block) throw new Error(`tl_getinfo: ${tlgiRes.error}`);
            const bbData = tlgiRes.data.block + TRADE_EXPIRY_BLOCKS;
            const cpitLTCOptions = [ propIdDesired, unitsToDecimal(amountDesired), unitsToDecimal(amountForSale), bbData ];
            const cpitRes = await this.client('tl_createpayload_instant_ltc_trade', cpitLTCOptions);
            if (cpitRes.error || !cpitRes.data) throw new Error(`tl_createpayload_instant_ltc_trade: ${cpitRes.error}`);
            const buildOptions: IBuildLTCITTxConfig = {
                buyerKeyPair: this.myInfo.keypair,
                sellerKeyPair: this.cpInfo.keypair,
                commitUTXOs: [commitUTXO],
                payload: cpitRes.data,
                amount: satsToLtc(amountForSale),
            };
            const rawHexRes = await this.txsService.buildLTCITTx(buildOptions);
            if (rawHexRes.error || !rawHexRes.data?.psbtHex) throw new Error(`Build Trade: ${rawHexRes.error}`);
            await this.sendPsbtToSeller(rawHexRes.data.psbtHex);
        } catch (error: any) {
            const errorMessge = error.message || 'Undefined Error';
            this.terminateTrade(`Step 3: ${errorMessge}`);
        }
    }

    // SELLER:STEP5 carries the seller's signature. From here the orderbook gives the buyer a bounded
    // window, so the wallet starts the window and checks it again before any broadcast.
    private async onStep5(cpId: string, psbtHex: string) {
        this.startSignedWindow();
        try {
            if (cpId !== this.cpInfo.socketId) return this.terminateTrade('Step 5: Error with p2p connection: code 4');
            if (!psbtHex) return this.terminateTrade('Step 5: PsbtHex Not Provided');
            // Sign only the transaction this wallet built. The seller returns the PSBT
            // with its signature added; any change to its inputs or outputs changes the
            // txid, and such a PSBT is refused before anything is signed or broadcast.
            const decRes = await decodePsbt(this.client, psbtHex);
            if (decRes.error || !this.expectedTxid || psbtTxid(decRes.data) !== this.expectedTxid) {
                return this.terminateTrade('Step 5: PSBT does not match the transaction this wallet built');
            }
            const wif = this.txsService.getWifByAddress(this.myInfo.keypair.address);
            if (!wif) return this.terminateTrade(`Step 5: getWifByAddress: WIF not found: ${this.myInfo.keypair.address}`);
            const signRes = await this.txsService.signPsbt({ wif, psbtHex });
            if (signRes.error || !signRes.data) return this.terminateTrade(`Step 5: signPsbt: ${signRes.error}`);
            if (!signRes.data.isFinished || !signRes.data.finalHex) return this.terminateTrade(`Step 5: Transaction not Full Synced`);
            // The window may have ended while signing. Then the orderbook has already closed the swap as
            // unverified, and nothing may be broadcast.
            if (this.isFinished) return;
            this.committed = true;
            const sendRes = await this.txsService.sendTx(signRes.data.finalHex);
            if (sendRes.error || !sendRes.data) {
                // The txid is known before broadcast. If the node has no such transaction, nothing was
                // broadcast and the swap is aborted. If it has one, the broadcast happened.
                const onChain = await this.client('getrawtransaction', [this.expectedTxid, true]);
                if (onChain.error || !onChain.data) {
                    this.committed = false;
                    return this.terminateTrade(`Step 5: sendRawTransaction: ${sendRes.error || 'no txid returned'}`);
                }
            }
            this.emitSwapEvent('BUYER:STEP6', this.expectedTxid);
        } catch (error: any) {
            // Called without await from the event dispatcher: a throw here would be an unhandled rejection.
            this.terminateTrade(`Step 5: ${error?.message || 'Undefined Error'}`);
        }
    }
}
