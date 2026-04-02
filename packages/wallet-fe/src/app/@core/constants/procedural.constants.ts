export const M1_RECEIPT_TEMPLATE_ID = 'dlc-receipt-ltc-testnet-v1';
export const M1_RECEIPT_TEMPLATE_HASH = '6d4e9721bcbf9f04e3079852a24d6d412e3a4c8a25388a19075f960f24c4695b';
export const M1_RECEIPT_CONTRACT_ID = 'ltc-testnet-epoch-1-1774833061943';
export const M1_RECEIPT_PROPERTY_ID = 380;
export const M1_OPERATOR_ADDRESS = 'tltc1qt8runj85htfsz578puvrck23c0razsmk3j0nqa';
export const M1_FUNDING_ADDRESS = 'tltc1qpvycy24gkt539w8lz4fzvkwff0lld5zdzdf7tn';
export const M1_ORACLE_ADDRESS = 'tltc1q234gdx8a0e7et4azxq383f7l5w24thk2japh9l';
export const M1_RESIDUAL_ADDRESS = 'tltc1qa4avlgdmq5h92fkgh83hcls29w9gcvd9d93y9c';
export const M1_RECEIPT_TICKER = 'rLTC-SAT';
export const M1_COLLATERAL_PROPERTY_ID = 1;

export interface BitvmDlcSetupConfig {
  collateralPropertyId: number;
  receiptPropertyId?: number;
  receiptTicker?: string;
  adminAddress: string;
  vaultAddress: string;
  fundingAddress: string;
  templateId: string;
  dlcHash: string;
  contractId: string;
}

export type ProceduralReceiptConfig = BitvmDlcSetupConfig;

export const M1_BITVM_DLC_SETUP_CONFIG: BitvmDlcSetupConfig = {
  collateralPropertyId: M1_COLLATERAL_PROPERTY_ID,
  receiptPropertyId: M1_RECEIPT_PROPERTY_ID,
  receiptTicker: M1_RECEIPT_TICKER,
  adminAddress: M1_OPERATOR_ADDRESS,
  vaultAddress: M1_OPERATOR_ADDRESS,
  fundingAddress: M1_FUNDING_ADDRESS,
  templateId: M1_RECEIPT_TEMPLATE_ID,
  dlcHash: M1_RECEIPT_TEMPLATE_HASH,
  contractId: M1_RECEIPT_CONTRACT_ID,
};

export const M1_PROCEDURAL_RECEIPT_CONFIG: ProceduralReceiptConfig = M1_BITVM_DLC_SETUP_CONFIG;
