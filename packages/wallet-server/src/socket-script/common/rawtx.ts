import { IBuildRawTxOptions, IInputs, TClient } from "./types";

export class RawTx {
    private client: TClient;
    private fromAddress: string;
    private toAddress: string;
    private inputs: IInputs[] = [];
    private payload: string;
    private refAddressAmount: number = 0;

    private sortedUTXOs: IInputs[];
    private minFeeLtcPerKb = 0.00001;
    private txReadyForsigning: string;
    private txReadyForSend: string;

    constructor(options: IBuildRawTxOptions, client: TClient) {
        const { fromAddress, toAddress, inputs, payload, refAddressAmount } = options;
        this.fromAddress = fromAddress;
        this.toAddress = toAddress;
        if (inputs) this.inputs = inputs;
        if (payload) this.payload = payload;
        if (refAddressAmount) this.refAddressAmount = refAddressAmount;
        this.client = client;
    }

    async build() {
        const validateAddreses = await this.validateAddresses();
        const validateErrorMessage = 'Error with Validating provided Addresses';
        if (validateAddreses.error || !validateAddreses.data) return { error: validateAddreses.error || validateErrorMessage };

        const luRes = await this.client('listunspent', 0, 999999999, [this.fromAddress]);
        const luResErrorMessage = `Error with getting unspents for address ${this.fromAddress}`;
        if (luRes.error || !luRes.data) return { error: luRes.error || luResErrorMessage };
        if (luRes.data.length < 1) return { error: `Not enough LTC for this transaction` };
        this.sortedUTXOs = luRes.data.sort((a: IInputs, b: IInputs) => b.amount - a.amount);

        const gmvaRes = await this.getMinVoutAmount();
        const gmvaErrorMessage = `Error with getting minimum vOut amount`;
        if (gmvaRes.error || !gmvaRes.data) return { error: gmvaRes.error || gmvaErrorMessage };

        const amount = this.refAddressAmount > gmvaRes.data ? this.refAddressAmount : gmvaRes.data;

        const allInputs = [...this.inputs, ...this.sortedUTXOs];
        const fundRawTxRes = await this.fundRawTx(allInputs, amount);
        const fundRawTxErrorMessage = `Error with funding the transaction`;
        if (fundRawTxRes.error || !fundRawTxRes.data) return { error: fundRawTxRes.error || fundRawTxErrorMessage };
        const { fundInputs, fundRawTxHex } = fundRawTxRes.data;

        const crtxrRes = await this.client('tl_createrawtx_reference', fundRawTxHex, this.toAddress, this.refAddressAmount || 0);
        const crtxrErrorMessage = `Error with Adding Ref address when building RawTx`;
        if (crtxrRes.error || !crtxrRes.data) return { error: crtxrRes.error || crtxrErrorMessage };

        let hex = crtxrRes.data;

        if (this.payload) {
            const crtxoRes = await this.client('tl_createrawtx_opreturn', crtxrRes.data);
            const crtxoResErrorMessage = `Error with adding payload to rawtx`;
            if (crtxoRes.error || !crtxoRes.data) return { error: crtxoRes.error || crtxoResErrorMessage };
            hex = crtxoRes.data;
        }

        const srtxRes = await this.client('signrawtransaction', hex);
        const srtxErrorMessage =  `Error with Siging rawtx`;
        if (srtxRes.error || !srtxRes.data?.hex) return { error: srtxRes.error || srtxErrorMessage };
    
        const estFeeRes = await this.getEstFeeOfTx(srtxRes.data.hex, 35); // +35 bytes size for adding one more output (change adderss);
        const estFeeErrorMessage =  `Error with calcualting the fees`;
        if (estFeeRes.error || !estFeeRes.data) return { error: estFeeRes.error || estFeeErrorMessage };
        
        const prevTxs = fundInputs.map(u => ({...u, value: u.amount }));
        const crtxcRes = await this.client('tl_createrawtx_change', crtxrRes.data, prevTxs, this.fromAddress, estFeeRes.data);
        const crtxcErrorMessage = `Error with Adding Change address when building RawTx`;
        if (crtxcRes.error || !crtxcRes.data) return { error: crtxcRes.error || crtxcErrorMessage };
        this.txReadyForsigning = crtxcRes.data;
        return { data: crtxcRes.data };
    }

    async signRawTx() {
        if (!this.txReadyForsigning) return { error: `Not found ready for signing tx`}
        const srtxRes = await this.client('signrawtransaction', this.txReadyForsigning);
        const srtxErrorMessage =  `Error with Siging rawtx`;
        if (srtxRes.error || !srtxRes.data?.hex) return { error: srtxRes.error || srtxErrorMessage };
        if (srtxRes.data.complete) this.txReadyForSend = srtxRes.data.hex;
        return { data: srtxRes.data.hex };
    }

    async sendrawTx() {
        if (!this.txReadyForSend) return { error: `Not found ready for send tx`}
        const srtxRes = await this.client('sendrawtransaction', this.txReadyForSend);
        const srtxErrorMessage =  `Error with Sending rawtx`;
        if (srtxRes.error || !srtxRes.data) return { error: srtxRes.error || srtxErrorMessage };
        return { data: srtxRes.data };
    }

    private async getEstFeeOfTx(hex: string, sizeToAdd: number = 0) {
        const drtx = await this.client('decoderawtransaction', hex);
        const drtxErrorMessage =  `Error with decoding ratx during building it`;
        if (drtx.error || !drtx.data) return { error : drtx.error || drtxErrorMessage };
        const predictedSize = parseFloat(drtx.data.size) + sizeToAdd;
        const estFee = parseFloat(((predictedSize * 0.001) * this.minFeeLtcPerKb).toFixed(8));
        return { data: estFee };
    }

    private async fundRawTx(inputs: IInputs[], amount: number, _hex: string = '') {
        const getEnoughInputs = () => {
            const inputsArr = [];
            inputs.some(u => {
                const _amountSum: number = inputsArr.map(r => r.amount).reduce((a, b) => a + b, 0);
                const amountSum = parseFloat(_amountSum.toFixed(10));
                const _amount = parseFloat((amount + ((0.2 * this.minFeeLtcPerKb) * (inputsArr.length + 1))).toFixed(10));
                if (amountSum < _amount) inputsArr.push(u);
                return amountSum >= _amount;
            });
            return inputsArr;
        };
        const _inputs = getEnoughInputs();
        const _inputsSum = _inputs.map(r => r.amount).reduce((a, b) => a + b, 0);
        const inputsSum = parseFloat(_inputsSum.toFixed(10));
        const _amount = parseFloat((amount + ((0.2 * this.minFeeLtcPerKb) * _inputs.length)).toFixed(10));
        if (inputsSum < _amount) return { error: `Not enough LTC for this transaction` };

        let hex = _hex;
        for (const vin of _inputs) {
            const crtxiRes = await this.client('tl_createrawtx_input', hex, vin.txid, vin.vout);
            if (crtxiRes.error || !crtxiRes.data) return { error: crtxiRes.error || 'Error with creating raw tx from provided inputs!' };
            hex = crtxiRes.data;
        }
        const data = { fundInputs: _inputs, fundRawTxHex: hex };
        return { data };
    }

    private async validateAddresses() {
        const vaFaRes = await this.client('validateaddress', this.fromAddress);
        const vaFaResErrorMessage = `Provided Sender Address (${this.fromAddress}) is not valid!`
        if (vaFaRes.error || !vaFaRes.data?.isvalid) return { error: vaFaRes.error || vaFaResErrorMessage };
    
        const vaToRes = await this.client('validateaddress', this.toAddress);
        const vaToResErrorMessage = `Provided Receiver Address (${this.toAddress}) is not valid!`
        if (vaToRes.error || !vaToRes.data?.isvalid) return { error: vaToRes.error || vaToResErrorMessage };
    
        if (this.fromAddress === this.toAddress) return { error: `Sender's and Receiver's Addresses could not be the same!`};
        return { data: true };
    }

    private async getMinVoutAmount() {
        const crtxrRes = await this.client('tl_createrawtx_reference', '', this.toAddress);
        if (crtxrRes.error || !crtxrRes.data) return { error: crtxrRes.error || `Error with Adding Ref address when building RawTx`};
        const drw = await this.client('decoderawtransaction', crtxrRes.data);
        if (drw.error || !drw.data) return { error: drw.error || `Error with Decoding RawTx during Building it`};
        return { data: parseFloat(drw.data.vout[0].value) };
    }
}