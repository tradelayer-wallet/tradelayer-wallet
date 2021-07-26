import { Receiver } from './receiver';
import {
    LITOptions,
    ROptions,
    Events1 as emmitEvents,
    Events2 as onEvents,
    TClient,
} from '../common/types';

export class LtcInstantTrade extends Receiver {

    constructor(client: TClient, host: string, trade: LITOptions, options: ROptions) {
        super(client, host, trade, options);
        this.handleSubListeners();
    }

    private handleSubListeners(): void {
        this.socket.on(onEvents.COMMIT_TX, this.onCommitTx.bind(this));
    }

    private async onCommitTx(data: any) {
        if (!data.txid || !data.utxoData) return this.terminateTrade(`Wrong provided Data onCommitTx`);
        const rawHex = await this.buildLTCInstantTrade(data);
        if (!rawHex) return;
        this.socket.emit(emmitEvents.RAWTX_FOR_SIGNING, rawHex);
    }

    private async buildLTCInstantTrade(data: any) {
        const _cpCommitTx = data.utxoData;
        const bbData: number = await this.getBestBlock(10);
        if (!bbData) return this.terminateTrade(`Error with getting best block, ${bbData}`);
        const trade = this.trade as LITOptions
        const { propertyid, amount, price } = trade;
        const cpitLTCOptions = [ propertyid, amount.toString(), price.toString(), bbData ];
        const cpitRes = await this.client('tl_createpayload_instant_ltc_trade', ...cpitLTCOptions);
        if (cpitRes.error || !cpitRes.data) return this.terminateTrade(cpitRes.error || `Error with creating payload`);

        const clientVins = await this.getUnspentsForFunding(price);
        if (clientVins.error || !clientVins.data?.length) return this.terminateTrade(cpitRes.error || `Error with finding enough unspents for ${this.receiverAddress}`);

        const vins = [_cpCommitTx, ...clientVins.data];
        const bLTCit = await this._buildLTCInstantTrade(vins, cpitRes.data, this.receiverAddress, price, this.listenerAddress);
        if (bLTCit.error || !bLTCit.data) return this.terminateTrade(bLTCit.error || `Error with Building LTC Instat Trade`);
        return bLTCit.data
    }

    private async _buildLTCInstantTrade(
        vins: any[],
        payload: string,
        changeAddress: string,
        price: number,
        refAddress: string,
    ): Promise<{ data?: any[], error?: any }> {
        if (!vins?.length || !payload || !refAddress || !price || !changeAddress) return { error: 'Missing argumetns for building LTC Instant Trade' };

        const sumVinsAmount = vins.map(vin => vin.amount).reduce((a, b) => a + b, 0);
        if (sumVinsAmount < price) {
            return { error: 'Error with vins' };
        }
        const tl_createrawtx_inputAll = async () => {
            let hex = '';
            for (const vin of vins) {
                const crtxiRes: any = await this.client('tl_createrawtx_input', hex, vin.txid, vin.vout);
                if (crtxiRes.error || !crtxiRes.data) return { error: 'Error with creating raw tx' };
                hex = crtxiRes.data;
            }
            return { data: hex };
        };
        const crtxiRes: any = await tl_createrawtx_inputAll();
        if (crtxiRes.error || !crtxiRes.data) return { error: 'Error with creating raw tx' };
        const change = (sumVinsAmount - (price + 0.0005)).toFixed(4);
        const _crtxrRes: any = await this.client('tl_createrawtx_reference', crtxiRes.data, changeAddress, change);
        if (_crtxrRes.error || !_crtxrRes.data) return { error: _crtxrRes.error || 'Error with adding referance address' };
    
        const crtxrRes: any = await this.client('tl_createrawtx_reference', _crtxrRes.data, refAddress, price.toString());
        if (crtxrRes.error || !crtxrRes.data) return { error: crtxrRes.error || 'Error with adding referance address' };
    
        const crtxoRes: any = await this.client('tl_createrawtx_opreturn', crtxrRes.data, payload);
        if (crtxoRes.error || !crtxoRes.data) return { error: 'Error with adding payload' };
        return crtxoRes;
    }

    private async getUnspentsForFunding(amount: number): Promise<{ data?: any[], error?: any }> {
        const lusRes = await this.client('listunspent', 0, 999999999, [this.receiverAddress]);
        if (lusRes.error || !lusRes.data?.length) {
          return lusRes
        } else {
          let res: any[] = [];
          lusRes.data.forEach((u: any) => {
            const amountSum = res.map(r => r.amount).reduce((a, b) => a + b, 0);
            if (amountSum < (amount + 0.1)) res.push(u);
          });
          return { data: res.map(u => ({vout: u.vout, txid: u.txid, amount: u.amount})) };
        }
    }
}