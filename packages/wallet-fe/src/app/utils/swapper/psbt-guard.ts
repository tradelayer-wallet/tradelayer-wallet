// Checks that a PSBT the counterparty returns for signing is the transaction that was
// agreed. Pure: no RPC, no I/O. The caller rebuilds the expected transaction from the
// agreed trade and its own node (SellSwapper.buildPsbtExpectation) and passes it in.
//
// The expected shape is the one the relayer builder produces for an LTC-for-tokens spot
// trade, wallet-server/src/services/tx-builder.service.ts buildLTCInstatTx (lines 86-138):
//   inputs : the seller's commit output (always first), then only the buyer's own UTXOs
//   outputs: seller <- sellerSats, buyer <- change, one OP_RETURN with the TL payload (0 value)
//   fee    : 0.3 * 0.002 LTC per input (getEnoughInputs2, line 211/214), 60000 sat per input
// Anything else is refused.

export const SATS_PER_LTC = 100000000;
// tx-builder.service.ts getEnoughInputs2: 0.3 * minFeeLtcPerKb per input.
export const LTC_FEE_SATS_PER_INPUT = 60000;
// Ceiling on the fee of one trade transaction. The exact fee above already bounds it;
// this is a second, independent limit.
export const MAX_TRADE_FEE_SATS = 5000000;
// buyer.ts sets the trade's block expiry to the buyer's tip + TRADE_EXPIRY_BLOCKS. The seller
// cannot know the buyer's tip, so it accepts an expiry within TRADE_EXPIRY_TOLERANCE_BLOCKS
// of its own tip + TRADE_EXPIRY_BLOCKS. This is the only value the seller does not derive exactly.
export const TRADE_EXPIRY_BLOCKS = 100;
export const TRADE_EXPIRY_TOLERANCE_BLOCKS = 6;

// Float representation tolerance for LTC amounts in decodepsbt output (1e-6 sat). Not an
// economic tolerance: a value that is not a whole number of satoshis is refused.
const SAT_EPSILON = 1e-6;

export interface IPsbtInputExpectation {
    txid: string;
    vout: number;
    sats: number;
    scriptHex: string;
}

export interface IPsbtExpectation {
    // scriptPubKey hex of the seller's address: receives exactly sellerSats.
    sellerScriptHex: string;
    // scriptPubKey hex of the buyer's address: the change output, and the only script an
    // input besides the seller's commit may spend.
    buyerScriptHex: string;
    sellerSats: number;
    // Smallest output the chain accepts for the buyer's change.
    dustSats: number;
    // The seller's own commit output: the one input the seller's key may sign.
    commit: IPsbtInputExpectation;
    // Every OP_RETURN scriptPubKey hex the trade payload may produce (one per accepted expiry).
    opReturnScriptHexes: string[];
}

const refuse = (why: string): never => {
    throw new Error(`PSBT refused: ${why}`);
};

const isObject = (v: unknown): v is Record<string, any> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

const asObject = (v: unknown, what: string): Record<string, any> =>
    isObject(v) ? v : refuse(`${what} missing or not an object`);

const asArray = (v: unknown, what: string): any[] =>
    Array.isArray(v) ? v : refuse(`${what} missing or not a list`);

const asHex = (v: unknown, what: string): string =>
    typeof v === 'string' && /^([0-9a-f]{2})+$/i.test(v) ? v.toLowerCase() : refuse(`${what} is not hex`);

const asTxid = (v: unknown, what: string): string =>
    typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v) ? v.toLowerCase() : refuse(`${what} is not a txid`);

const asIndex = (v: unknown, what: string): number =>
    Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : refuse(`${what} is not an output index`);

// Converts an LTC amount to satoshis. Refuses anything that is not a whole number of satoshis.
export const ltcToSats = (value: unknown, what = 'amount'): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        return refuse(`${what} is not a non-negative number`);
    }
    const scaled = value * SATS_PER_LTC;
    const sats = Math.round(scaled);
    if (!Number.isSafeInteger(sats) || Math.abs(scaled - sats) > SAT_EPSILON) {
        return refuse(`${what} is not a whole number of satoshis`);
    }
    return sats;
};

// Transaction id of a decoded PSBT, or null when it is absent or malformed. Used by both
// sides: the buyer records it at send time, and checks the returned PSBT against it.
export const psbtTxid = (decoded: unknown): string | null => {
    const txid = isObject(decoded) && isObject(decoded.tx) ? decoded.tx.txid : undefined;
    return typeof txid === 'string' && /^[0-9a-f]{64}$/i.test(txid) ? txid.toLowerCase() : null;
};

const outpointKey = (txid: string, vout: number) => `${txid}:${vout}`;

// Throws unless the decoded PSBT is exactly the expected LTC-for-tokens trade transaction.
// `decoded` is a decodepsbt result (Bitcoin Core / Litecoin Core shape: tx.vin, tx.vout,
// inputs[i].witness_utxo). Every field the check relies on is required; a missing or
// malformed one refuses. The check never signs or sends anything.
export const assertPsbtMatchesTrade = (decoded: unknown, expected: IPsbtExpectation): void => {
    const sellerScript = asHex(expected.sellerScriptHex, 'expected seller script');
    const buyerScript = asHex(expected.buyerScriptHex, 'expected buyer script');
    if (sellerScript === buyerScript) refuse('seller and buyer scripts are the same');
    const commitScript = asHex(expected.commit.scriptHex, 'expected commit script');
    const commitKey = outpointKey(asTxid(expected.commit.txid, 'expected commit txid'), asIndex(expected.commit.vout, 'expected commit vout'));
    const opReturns = new Set(expected.opReturnScriptHexes.map((h) => asHex(h, 'expected OP_RETURN script')));
    if (!(expected.sellerSats > 0) || !Number.isSafeInteger(expected.sellerSats)) refuse('expected seller amount invalid');
    if (!Number.isSafeInteger(expected.dustSats) || expected.dustSats < 0) refuse('expected dust invalid');
    if (opReturns.size === 0) refuse('no expected OP_RETURN');

    const root = asObject(decoded, 'PSBT');
    const tx = asObject(root.tx, 'tx');
    const vin = asArray(tx.vin, 'tx.vin');
    const vout = asArray(tx.vout, 'tx.vout');
    const psbtInputs = asArray(root.inputs, 'PSBT inputs');
    if (vin.length === 0) refuse('no inputs');
    if (psbtInputs.length !== vin.length) refuse('input records do not match the transaction inputs');
    if (tx.locktime !== 0) refuse('transaction has a locktime');

    // Inputs: the commit output exactly once, with the amount and script this swap created.
    // Every other input must be at the buyer's address. The seller's key only signs its own
    // script, so no other input is touched by the seller's signature.
    let inSats = 0;
    let commitSeen = 0;
    const seen = new Set<string>();
    vin.forEach((input, i) => {
        const inObj = asObject(input, `input ${i}`);
        const key = outpointKey(asTxid(inObj.txid, `input ${i} txid`), asIndex(inObj.vout, `input ${i} vout`));
        if (seen.has(key)) refuse(`input ${i} repeats an earlier input`);
        seen.add(key);
        const utxo = asObject(asObject(psbtInputs[i], `input record ${i}`).witness_utxo, `input ${i} witness_utxo`);
        const sats = ltcToSats(utxo.amount, `input ${i} amount`);
        const scriptHex = asHex(asObject(utxo.scriptPubKey, `input ${i} scriptPubKey`).hex, `input ${i} script`);
        if (key === commitKey) {
            commitSeen++;
            if (sats !== expected.commit.sats || scriptHex !== commitScript) {
                refuse('commit input does not match the commit output of this swap');
            }
        } else if (scriptHex !== buyerScript) {
            refuse(`input ${i} is not at the buyer's address`);
        }
        inSats += sats;
    });
    if (commitSeen !== 1) refuse('commit input missing');
    if (!Number.isSafeInteger(inSats)) refuse('input total out of range');

    // Fee and buyer change. The builder sets the change to inputs - seller - fee, so the change
    // is fixed by the inputs and the fee. A different change is refused.
    const fee = LTC_FEE_SATS_PER_INPUT * vin.length;
    if (fee > MAX_TRADE_FEE_SATS) refuse('fee above the maximum');
    const buyerSats = inSats - expected.sellerSats - fee;
    if (buyerSats < expected.dustSats) refuse('inputs do not cover the trade and fee');

    // Outputs: exactly one to the seller, one change to the buyer, one OP_RETURN with value 0.
    let sellerOuts = 0;
    let buyerOuts = 0;
    let dataOuts = 0;
    let outSats = 0;
    vout.forEach((out, i) => {
        const outObj = asObject(out, `output ${i}`);
        if (asIndex(outObj.n, `output ${i} n`) !== i) refuse(`output ${i} index is out of order`);
        const sats = ltcToSats(outObj.value, `output ${i} value`);
        const scriptHex = asHex(asObject(outObj.scriptPubKey, `output ${i} scriptPubKey`).hex, `output ${i} script`);
        outSats += sats;
        if (scriptHex === sellerScript) {
            sellerOuts++;
            if (sats !== expected.sellerSats) refuse(`seller output is ${sats} sat, agreed ${expected.sellerSats}`);
        } else if (scriptHex === buyerScript) {
            buyerOuts++;
            if (sats !== buyerSats) refuse(`buyer output is ${sats} sat, expected ${buyerSats}`);
        } else if (opReturns.has(scriptHex)) {
            dataOuts++;
            if (sats !== 0) refuse('OP_RETURN output carries value');
        } else {
            refuse(`output ${i} is not one of the expected outputs`);
        }
    });
    if (sellerOuts !== 1 || buyerOuts !== 1 || dataOuts !== 1) refuse('output set differs from the agreed trade');
    if (inSats - outSats !== fee) refuse('fee differs from the agreed fee');
};
