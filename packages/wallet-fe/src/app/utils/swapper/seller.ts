import { Socket as SocketClient } from 'socket.io-client';
import { IBuildTxConfig, TxsService } from "src/app/@core/services/txs.service";
import { decodePsbt, IBuyerSellerInfo, IFuturesTradeProps, IMSChannelData, ISpotTradeProps, ETradeType, TClient } from "./common";
import { assertPsbtMatchesTrade, assertSellerSignature, IPsbtExpectation, TRADE_EXPIRY_BLOCKS, TRADE_EXPIRY_TOLERANCE_BLOCKS } from "./psbt-guard";
import { Swap } from "./swap";
import { ICommitUtxo, ISwapRelay, TSwapEventData } from "./protocol";
import { ltcToSats, unitsToDecimal } from "../units";

export class SellSwapper extends Swap {
    // The seller's own commit output, set in onStep2. The only input the seller signs for.
    private commitUtxo: ICommitUtxo | null = null;
    // Txid of the transaction this seller validated and signed, set in onStep4. The broadcast
    // must be that transaction; a counterparty's claim of any other txid is refused.
    private validatedTxid: string | null = null;

    constructor(
        sessionId: string,
        typeTrade: ETradeType,
        tradeInfo: IFuturesTradeProps | ISpotTradeProps,
        sellerInfo: IBuyerSellerInfo,
        buyerInfo: IBuyerSellerInfo,
        client: TClient,
        socket: SocketClient,
        txsService: TxsService,
    ) {
        super(sessionId, typeTrade, tradeInfo, sellerInfo, buyerInfo, client, socket, txsService);
        this.initTrade();
    }

    protected outcomeTxid(): string | null {
        return this.validatedTxid;
    }

    protected handleSwapEvent(event: ISwapRelay & { socketId: string }) {
        const { socketId, data } = event;
        switch (event.eventName) {
            case 'BUYER:STEP2':
                this.onStep2(socketId);
                break;
            case 'BUYER:STEP4':
                this.onStep4(socketId, data as string);
                break;
            case 'BUYER:STEP6':
                this.onStep6(socketId, data as TSwapEventData['BUYER:STEP6']);
                break;
            default:
                break;
        }
    }

    private async initTrade() {
        try {
            const pubKeys = [this.myInfo.keypair.pubkey, this.cpInfo.keypair.pubkey];

            const amaRes = await this.client("addmultisigaddress", [2, pubKeys]);
            if (amaRes.error || !amaRes.data) throw new Error(`addmultisigaddress: ${amaRes.error}`);
            this.multySigChannelData = (amaRes.data as IMSChannelData);

            const validateMS = await this.client("validateaddress", [this.multySigChannelData.address]);
            if (validateMS.error || !validateMS.data?.scriptPubKey) throw new Error(`Init Trade: validateaddress: ${validateMS.error}`);
            this.multySigChannelData.scriptPubKey = validateMS.data.scriptPubKey;

            this.emitSwapEvent(`SELLER:STEP1`, this.multySigChannelData);
        } catch (error: any) {
            const errorMessge = error.message || 'Undefined Error';
            this.terminateTrade(`InitTrade: ${errorMessge}`);
        }
    }

    private async onStep2(cpId: string) {
        try {
            if (!this.multySigChannelData?.address) throw new Error(`Error with finding Multisig Address`);
            if (cpId !== this.cpInfo.socketId) throw new Error(`Error with p2p connection`);
            // Refuse an unmodelled trade before the commit is broadcast: a commit that is never
            // traded leaves the seller's output in the channel.
            if (!this.isModelledTrade()) throw new Error(`trade not modelled: refusing before commit`);

            const fromKeyPair = { address: this.myInfo.keypair.address };
            const toKeyPair = { address: this.multySigChannelData.address };
            const commitTxConfig: IBuildTxConfig = { fromKeyPair, toKeyPair };

            const ctcpParams = [];
            if (this.typeTrade === ETradeType.SPOT && 'propIdDesired' in this.tradeInfo) {
                const { propIdDesired, amountDesired } = this.tradeInfo;
                ctcpParams.push(propIdDesired, unitsToDecimal(amountDesired));
            } else if (this.typeTrade === ETradeType.FUTURES && 'contract_id' in this.tradeInfo) {
                const { amount, collateral } = this.tradeInfo;
                ctcpParams.push(collateral, unitsToDecimal(amount));
            } else {
                throw new Error(`Unrecognized Trade Type: ${this.typeTrade}`);
            }
            const cpctcRes = await this.client('tl_createpayload_commit_tochannel', ctcpParams);
            if (cpctcRes.error || !cpctcRes.data) throw new Error(`tl_createpayload_commit_tochannel: ${cpctcRes.error}`);

            const payload = cpctcRes.data;
            commitTxConfig. payload = payload;
            // build Commit Tx
            const commitTxRes = await this.txsService.buildTx(commitTxConfig);
            if (commitTxRes.error || !commitTxRes.data) throw new Error(`Build Commit TX: ${commitTxRes.error}`);
            const { inputs, rawtx } = commitTxRes.data;
            const wif = this.txsService.getWifByAddress(this.myInfo.keypair.address);
            if (!wif) throw new Error(`WIF not found: ${this.myInfo.keypair.address}`);

            // Everything the commit output is recorded with is read before anything is signed or sent. After the
            // broadcast nothing may throw, so a broadcast commit is always recorded.
            const drtRes = await this.client("decoderawtransaction", [rawtx]);
            if (drtRes.error || !drtRes.data?.vout) throw new Error(`decoderawtransaction: ${drtRes.error}`);
            const vout = drtRes.data.vout.find((o: any) => o.scriptPubKey?.addresses?.[0] === this.multySigChannelData?.address);
            if (!vout) throw new Error(`decoderawtransaction (2): ${drtRes.error}`);
            // The node's LTC float becomes satoshis once, here. Everything else on the wire is satoshis.
            const sats = ltcToSats(vout.value, 'commit amount');

            // sign Commit Tx
            const cimmitTxSignRes = await this.txsService.signTx({ rawtx, inputs, wif });
            if (cimmitTxSignRes.error || !cimmitTxSignRes.data) throw new Error(`Sign Commit TX: ${cimmitTxSignRes.error}`);
            const { isValid, signedHex } = cimmitTxSignRes.data;
            if (!isValid || !signedHex) throw new Error(`Sign Commit TX (2): ${cimmitTxSignRes.error}`);

            // The negotiation window may have ended while the commit was being built. Then the swap is over,
            // and nothing may be broadcast.
            if (this.isFinished) return;

            // send Commit Tx
            const commiTxSendRes = await this.txsService.sendTx(signedHex);
            if (commiTxSendRes.error || !commiTxSendRes.data) throw new Error(`Send Commit TX: ${commiTxSendRes.error}`);

            this.commitUtxo = {
                txid: commiTxSendRes.data,
                vout: vout.n,
                sats,
                scriptPubKey: this.multySigChannelData.scriptPubKey,
                redeemScript: this.multySigChannelData.redeemScript,
            };
            // The buyer's answer is due now, so the negotiation window restarts at the commit.
            this.startNegotiationWindow();
            this.emitSwapEvent(`SELLER:STEP3`, this.commitUtxo);
        } catch (error: any) {
            const errorMessge = error.message || 'Undefined Error';
            this.terminateTrade(`Step 2: ${errorMessge}`);
        }
    }

    // The transaction this seller will co-sign, rebuilt from the agreed trade and this node.
    // It mirrors buildLTCInstatTx (wallet-server tx-builder.service.ts:86-138) for the
    // LTC-for-tokens spot trade. Nothing comes from the buyer except the PSBT itself.
    private async buildPsbtExpectation(): Promise<IPsbtExpectation> {
        if (!this.isModelledTrade() || !('propIdDesired' in this.tradeInfo)) {
            throw new Error(`trade not modelled: refusing to sign`);
        }
        const { propIdDesired, amountDesired, amountForSale } = this.tradeInfo;
        const commit = this.commitUtxo;
        const channelScript = this.multySigChannelData?.scriptPubKey;
        if (!commit || !channelScript) throw new Error(`commit output of this swap is unknown`);

        const sellerAddress = this.myInfo.keypair.address;
        const buyerAddress = this.cpInfo.keypair.address;
        const sellerPubkeyHex = this.myInfo.keypair.pubkey;
        const buyerPubkeyHex = this.cpInfo.keypair.pubkey;
        const commitRedeemScriptHex = this.multySigChannelData?.redeemScript;
        if (!sellerPubkeyHex || !buyerPubkeyHex || !commitRedeemScriptHex) throw new Error(`keys or channel redeem script unknown`);
        const [sellerVa, buyerVa] = await Promise.all([
            this.client('validateaddress', [sellerAddress]),
            this.client('validateaddress', [buyerAddress]),
        ]);
        const sellerScript = sellerVa.data?.scriptPubKey;
        const buyerScript = buyerVa.data?.scriptPubKey;
        if (sellerVa.error || !sellerScript || buyerVa.error || !buyerScript) throw new Error(`validateaddress: no script`);

        // Dust value of the seller's output: the relayer's getMinVoutAmount, run on this node.
        const refRes = await this.client('tl_createrawtx_reference', ['', sellerAddress]);
        if (refRes.error || !refRes.data) throw new Error(`tl_createrawtx_reference: ${refRes.error}`);
        const refDec = await this.client('decoderawtransaction', [refRes.data]);
        if (refDec.error) throw new Error(`decoderawtransaction: ${refDec.error}`);
        const dustSats = ltcToSats(parseFloat(refDec.data?.vout?.[0]?.value), 'dust');
        // buildLTCInstatTx: the seller output is max(amount, minAmount). The agreed value is already in satoshis.
        const sellerSats = Math.max(amountForSale, dustSats);

        // The expiry is buyer tip + TRADE_EXPIRY_BLOCKS, so accept a small window around ours.
        const tlgi = await this.client('tl_getinfo');
        const tip = tlgi.data?.block;
        if (tlgi.error || !Number.isSafeInteger(tip)) throw new Error(`tl_getinfo: ${tlgi.error}`);
        const expiries: number[] = [];
        for (let d = -TRADE_EXPIRY_TOLERANCE_BLOCKS; d <= TRADE_EXPIRY_TOLERANCE_BLOCKS; d++) {
            expiries.push(tip + TRADE_EXPIRY_BLOCKS + d);
        }
        const opReturnScriptHexes = await Promise.all(
            expiries.map((expiry) => this.opReturnScriptFor(propIdDesired, amountDesired, amountForSale, expiry)),
        );

        return {
            sellerScriptHex: sellerScript,
            buyerScriptHex: buyerScript,
            sellerSats,
            dustSats,
            commit: {
                txid: commit.txid,
                vout: commit.vout,
                sats: commit.sats,
                scriptHex: channelScript,
            },
            opReturnScriptHexes,
            sellerPubkeyHex,
            buyerPubkeyHex,
            commitRedeemScriptHex,
        };
    }

    // OP_RETURN scriptPubKey the TL payload for these parameters produces, as the relayer
    // builds it (tl_createpayload_instant_ltc_trade, then tl_createrawtx_opreturn).
    private async opReturnScriptFor(propId: number | string, amountDesired: number, amountForSale: number, expiry: number): Promise<string> {
        const payloadRes = await this.client('tl_createpayload_instant_ltc_trade', [propId, unitsToDecimal(amountDesired), unitsToDecimal(amountForSale), expiry]);
        if (payloadRes.error || !payloadRes.data) throw new Error(`tl_createpayload_instant_ltc_trade: ${payloadRes.error}`);
        const rawRes = await this.client('tl_createrawtx_opreturn', ['', payloadRes.data]);
        if (rawRes.error || !rawRes.data) throw new Error(`tl_createrawtx_opreturn: ${rawRes.error}`);
        const decRes = await this.client('decoderawtransaction', [rawRes.data]);
        if (decRes.error || !Array.isArray(decRes.data?.vout)) throw new Error(`decoderawtransaction: ${decRes.error}`);
        const dataOuts = decRes.data.vout.filter((o: any) => typeof o?.scriptPubKey?.hex === 'string' && o.scriptPubKey.hex.toLowerCase().startsWith('6a'));
        if (dataOuts.length !== 1) throw new Error(`trade payload did not produce one OP_RETURN output`);
        return dataOuts[0].scriptPubKey.hex.toLowerCase();
    }

    private async onStep4(cpId: string, psbtHex: string) {
        try {
            if (cpId !== this.cpInfo.socketId) throw new Error(`Error with p2p connection`);
            if (!psbtHex) throw new Error(`PsbtHex for syncing not provided`);
            // Sign only the agreed transaction: rebuild it here, compare it with the PSBT, and
            // refuse, with nothing signed, on any difference.
            const expected = await this.buildPsbtExpectation();
            const decRes = await decodePsbt(this.client, psbtHex);
            if (decRes.error || !decRes.data) throw new Error(`decodepsbt: ${decRes.error}`);
            const { txid, commitIndex } = assertPsbtMatchesTrade(decRes.data, expected);
            this.validatedTxid = txid;
            const wif = this.txsService.getWifByAddress(this.myInfo.keypair.address);
            if (!wif) throw new Error(`WIF not found: ${this.myInfo.keypair.address}`);
            const signRes = await this.txsService.signPsbt({ wif, psbtHex });
            if (signRes.error || !signRes.data?.psbtHex) throw new Error(`Sign Tx: ${signRes.error}`);
            // The PSBT that goes back must be the validated transaction, with this wallet's
            // signature on the commit input and on nothing else.
            const signedRes = await decodePsbt(this.client, signRes.data.psbtHex);
            if (signedRes.error || !signedRes.data) throw new Error(`decodepsbt (signed): ${signedRes.error}`);
            assertSellerSignature(signedRes.data, { txid, commitIndex, sellerPubkeyHex: expected.sellerPubkeyHex });
            this.emitSwapEvent(`SELLER:STEP5`, signRes.data.psbtHex);
            // The signature is out: the buyer may broadcast now. The seller never terminates from here.
            this.committed = true;
            this.startSignedWindow();
        } catch (error: any) {
            const errorMessge = error.message || 'Undefined Error';
            this.terminateTrade(`Step 4: ${errorMessge}`);
        }
    }

    // Appended to every abort once the commit is broadcast (see finish in swap.ts). The commit was
    // broadcast at step 2 and cannot be unwound: it sits in the 2-of-2 channel, and spending it needs
    // the buyer's signature too.
    protected abortNotice(): string {
        if (!this.commitUtxo) return '';
        return ` Commit output ${this.commitUtxo.txid}:${this.commitUtxo.vout} is in the 2-of-2 channel; spending it needs the buyer's signature.`;
    }

    // BUYER:STEP6 reports the broadcast txid. The seller finishes only if it is the transaction it
    // signed. Any other txid cannot be the agreed trade, so the outcome is reported as unverified.
    private onStep6(cpId: string, txid: string) {
        if (cpId !== this.cpInfo.socketId || txid !== this.validatedTxid) {
            this.finish({ status: 'unverified', txid: this.validatedTxid });
            return;
        }
        this.finish({ status: 'settled', txid, trade: this.tradeInfo });
    }
}
