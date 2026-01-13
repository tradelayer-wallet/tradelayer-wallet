import BigNumber from 'bignumber.js'; // Make sure BigNumber is imported

const marker = 'tl';


const encodeAmount = (amt: number | string): string =>{
  const bigAmt = new BigNumber(amt);
  const scaledAmt = bigAmt.times(1e8);
  const isWholeNumber = bigAmt.mod(1).isZero();

  return isWholeNumber
    ? bigAmt.integerValue().toNumber().toString(36)  // Base36 encoding for whole numbers
    : scaledAmt.integerValue().toNumber().toString(36) + '~';  // Base36 with `~` for decimals
}

const encodeSend = (params: { sendAll: boolean, address: string, propertyId: number | number[], amount: number | number[] }) => {
    if (params.sendAll) return `1;${params.address}`;

    const encodeAmount = (amt: number) => {
        const scaledAmt = new BigNumber(amt).times(1e8);
        const isWholeNumber = Boolean(amt%1==0); // Check if it's an integer

        return isWholeNumber
            ? amt.toString(36) // Normal encoding
            : scaledAmt.integerValue().toString(36) + '~'; // Add 'd' flag for decimal mode
    };

    if (Array.isArray(params.propertyId) && Array.isArray(params.amount)) {
        const payload = [
            '0',
            '',
            params.propertyId.map(id => id.toString(36)).join(','),
            params.amount.map(encodeAmount).join(',') // Use the bimodal encoding function
        ];
        return payload.join(';');
    } else {
        const amountValue = Array.isArray(params.amount) ? params.amount[0] : params.amount;
        const payload = [
            '0',
            params.address,
            params.propertyId.toString(36),
            encodeAmount(amountValue) // Apply bimodal encoding
        ];
        const txNumber = 2;
        const txNumber36 = txNumber.toString(36);
        const payloadString = payload.join(';');
        return marker + txNumber36 + payloadString;
    }
};


type TradeTokensChannelParams = {
    propertyId1: number;
    propertyId2: number;
    amountOffered1: number;
    amountDesired2: number;
    columnAIsOfferer: number;
    expiryBlock: number;
    columnAIsMaker: number;
};

const encodeTradeTokensChannel = (params: TradeTokensChannelParams): string => {
    const payload = [
        params.propertyId1.toString(36),
        params.propertyId2.toString(36),
        new BigNumber(params.amountOffered1).times(1e8).toString(36), // Updated to use BigNumber
        new BigNumber(params.amountDesired2).times(1e8).toString(36), // Updated to use BigNumber
        params.columnAIsOfferer ? '1' : '0',
        params.expiryBlock.toString(36),
        params.columnAIsMaker
    ];
    const txNumber = 20;
    const txNumber36 = txNumber.toString(36);
    const payloadString = payload.join(',');
    return marker + txNumber36 + payloadString;
};

type EncodeCommitParams = {
    propertyId: number;
    amount: number;
    channelAddress: string;
    ref?: number; // New optional parameter for reference output
};

const encodeCommit = (params: EncodeCommitParams): string => {
    const payload = [
        params.propertyId.toString(36),
        new BigNumber(params.amount).times(1e8).toString(36),
        params.channelAddress.length > 42 ? `ref:${params.ref || 0}` : params.channelAddress // Handle long multisig addresses
    ];
    const txNumber = 4;
    const txNumber36 = txNumber.toString(36);
    const payloadString = payload.join(',');
    return marker + txNumber36 + payloadString;
};

type EncodeTradeTokenForUTXOParams = {
    propertyId: number;
    amount: number;
    columnA: number;
    satsExpected: number;
    tokenOutput: number;
    payToAddress: number;
};

const encodeTradeTokenForUTXO = (params: EncodeTradeTokenForUTXOParams): string => {
    const payload = [
        params.propertyId.toString(36),
        new BigNumber(params.amount).times(1e8).toString(36), // Updated to use BigNumber
        params.columnA,
        new BigNumber(params.satsExpected).times(1e8).toString(36),
        params.tokenOutput.toString(36),
        params.payToAddress.toString(36)
    ];

    const txNumber = 3;
    const txNumber36 = txNumber.toString(36);
    const payloadString = payload.join(',');
    return marker + txNumber36 + payloadString;
};

type EncodeTradeContractParams = {
  contractId: number;
  price: number;
  amount: number;
  columnAIsSeller: number;
  expiryBlock: number;
  insurance: boolean;
  columnAIsMaker: number
};


const encodeTradeContractChannel = (params: EncodeTradeContractParams): string => {
  const payload = [
    params.contractId.toString(36),    
    new BigNumber(params.price).times(1e8).integerValue(BigNumber.ROUND_HALF_UP).toString(36),
    params.amount.toString(36),
    params.columnAIsSeller,
    params.expiryBlock.toString(36),
    params.insurance ? '1' : '0',
    params.columnAIsMaker
  ];

  const type = 19;
  const typeStr = type.toString(36);

  return marker + typeStr + payload.join(',');
};

type EncodeTransferParams = {
    propertyId: number;
    amount: number;
    isColumnA: boolean;
    destinationAddr: string;
    ref?: number; // New optional parameter for reference output
};


// Encode Transfer Transaction 
const encodeTransfer = (params: EncodeTransferParams): string => {
    const propertyId = params.propertyId.toString(36);
    const amounts = new BigNumber(params.amount).times(1e8).toString(36);
    const isColumnA = params.isColumnA ? 1 : 0;
    const destinationAddr = params.destinationAddr.length > 42 ? `ref:${params.ref || 0}` : params.destinationAddr; // Handle long multisig addresses
    
    return [propertyId, amounts, isColumnA, destinationAddr].join(',');
};

// Encode Attestation Transaction
type EncodeAttestationParams = {
  revoke: number;
  id: number;
  targetAddress: string;
  metaData: string; // Usually a country code or similar metadata
};

const encodeAttestation = (params: EncodeAttestationParams): string => {
  const payload = [
    params.revoke.toString(36),      // Revoke flag (0 or 1)
    params.id.toString(36),         // ID (usually 0 for whitelist)
    params.targetAddress,           // Address being attested
    params.metaData                 // Metadata such as the country code
  ];
  const txNumber = 9; // Assuming attestation transaction is type 9
  const txNumber36 = txNumber.toString(36);
  const payloadString = payload.join(',');
  return marker + txNumber36 + payloadString;
};


// keep your existing EncodeCommitParams / encodeCommit

type EncodeWithdrawalParams = {
  withdrawAll: number | boolean;  // 1/0 or true/false
  propertyId: number;
  amountOffered: number | string; // decimal string or number
  column: number | boolean;       // 0/1 or A/B as boolean
  channelAddress: string;
  ref?: number;                    // NEW: reference output index
};

const encodeWithdrawal = (p: EncodeWithdrawalParams): string => {
  const withdrawAll = (p.withdrawAll ? 1 : 0).toString();
  const propertyIds = p.propertyId.toString(36);
  const amounts = new BigNumber(p.amountOffered)
    .times(1e8)
    .integerValue(BigNumber.ROUND_DOWN)
    .toString(36);
  const column = (typeof p.column === 'boolean' ? (p.column ? 1 : 0) : p.column).toString();
  const chanField = p.channelAddress.length > 42 ? `ref:${p.ref ?? 0}` : p.channelAddress;

  const type = 21;
  const typeStr = type.toString(36); // 'l'

  const payload = [withdrawAll, propertyIds, amounts, column, chanField].join(',');
  const out = marker + typeStr + payload;

  // Optional: keep OP_RETURN under standard policy
  // if (Buffer.byteLength(out, 'utf8') > 80) throw new Error('OP_RETURN too large');

  return out;
};

// --- Synth encode helpers ---

/** ---------- MINT ---------- */
export type EncodeMintSyntheticParams = {
  propertyId: number;   // underlying property id
  contractId: number;   // contract id used
  amount: string | number;
};

export const encodeMintSynthetic = (params: EncodeMintSyntheticParams): string => {
  const typeStr = (24).toString(36);
  const amt36 = new BigNumber(params.amount)
    .times(1e8)
    .integerValue(BigNumber.ROUND_DOWN)
    .toString(36);

  const payload = [
    Number(params.propertyId).toString(36),
    Number(params.contractId).toString(36),
    amt36,
  ];

  return marker + typeStr + payload.join(',');
};

/** ---------- REDEEM ---------- */
export type EncodeRedeemSyntheticParams = {
  propertyId: string;   // composite string e.g. "123-456"
  contractId: number;   // contract id used
  amount: string | number;
};

export const encodeRedeemSynthetic = (params: EncodeRedeemSyntheticParams): string => {
  const typeStr = (25).toString(36);

  const amt36 = new BigNumber(params.amount)
    .times(1e8)
    .integerValue(BigNumber.ROUND_DOWN)
    .toString(36);

  const payload = [
    Number(params.propertyId).toString(36),
    Number(params.contractId).toString(36),
    amt36,
  ];

  return marker + typeStr + payload.join(',');
};

export const ENCODER = { 
    encodeSend, 
    encodeTradeTokensChannel,
    encodeWithdrawal, 
    encodeTradeContractChannel,  
    encodeTradeTokenForUTXO, 
    encodeCommit,
    encodeTransfer,
    encodeAttestation,
    encodeMintSynthetic,
    encodeRedeemSynthetic
};