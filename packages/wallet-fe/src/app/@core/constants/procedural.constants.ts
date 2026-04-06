export const M1_RECEIPT_TEMPLATE_ID = 'dlc-receipt-ltc-testnet-v1';
export const M1_RECEIPT_TEMPLATE_HASH = '5a57ecb55beff99ff5b523d5cdd021aef3781df8b318f9ac9e176cc7c6400151';
export const M1_RECEIPT_CONTRACT_ID = 'ltc-testnet-epoch-1-1775408862103';
export const M1_RECEIPT_PROPERTY_ID = 380;
export const M1_OPERATOR_ADDRESS = 'tltc1q9c930xt6x5qjs8tyj5gsq36ktjcwa7eum9k7kg';
export const M1_FUNDING_ADDRESS = 'tltc1qpvycy24gkt539w8lz4fzvkwff0lld5zdzdf7tn';
export const M1_ORACLE_ADDRESS = 'tltc1qq2wx8zwv585eszp85qapd08qz26gs920m7p92j';
export const M1_RESIDUAL_ADDRESS = 'tltc1qwghcxqafwvhwj63sdetxck9uaqd9pzu255fsqw';
export const M1_RECEIPT_TICKER = 'rLTC-SAT';
export const M1_COLLATERAL_PROPERTY_ID = 1;

export interface BitvmDlcSetupConfig {
  collateralPropertyId: number;
  receiptPropertyId?: number;
  receiptTicker?: string;
  expiryArtifactName?: string;
  oracleId?: number;
  oracleAddress?: string;
  adminAddress: string;
  vaultAddress: string;
  residualAddress?: string;
  fundingAddress: string;
  feeAddress?: string;
  pnlEscrowAddress?: string;
  refundAddress?: string;
  rolloverAddress?: string;
  flatRecipientAddress?: string;
  pnlRecipientAddress?: string;
  feeRateBps?: number;
  pnlEscrowBps?: number;
  settlementSplitBps?: number;
  routePlan?: any;
  templateId: string;
  dlcHash: string;
  contractId: string;
}

export type ProceduralReceiptConfig = BitvmDlcSetupConfig;

export const M1_BITVM_DLC_SETUP_CONFIG: BitvmDlcSetupConfig = {
  collateralPropertyId: M1_COLLATERAL_PROPERTY_ID,
  receiptPropertyId: M1_RECEIPT_PROPERTY_ID,
  receiptTicker: M1_RECEIPT_TICKER,
  expiryArtifactName: 'm1_expiry_redemption_latest.json',
  oracleId: 0,
  oracleAddress: M1_ORACLE_ADDRESS,
  adminAddress: M1_OPERATOR_ADDRESS,
  vaultAddress: M1_OPERATOR_ADDRESS,
  residualAddress: M1_RESIDUAL_ADDRESS,
  fundingAddress: M1_FUNDING_ADDRESS,
  templateId: M1_RECEIPT_TEMPLATE_ID,
  dlcHash: M1_RECEIPT_TEMPLATE_HASH,
  contractId: M1_RECEIPT_CONTRACT_ID,
};

export const M1_PROCEDURAL_RECEIPT_CONFIG: ProceduralReceiptConfig = M1_BITVM_DLC_SETUP_CONFIG;
