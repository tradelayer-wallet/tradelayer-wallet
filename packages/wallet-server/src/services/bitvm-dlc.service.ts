import { computeMultisigNative, smartRpc } from "./tx-builder.service";

export interface IBitvmDlcSetupConfig {
  adminAddress: string;
  depositorAddress: string;
  amount: number | string;
  templateId: string;
  templateHash: string;
  contractId: string;
  vaultAddress?: string;
  walletLabel?: string;
  network: string;
}

export interface IBitvmDlcSetupBlueprint {
  kind: 'bitvm-dlc-setup';
  setupId: string;
  contractId: string;
  templateId: string;
  templateHash: string;
  operatorAddress: string;
  fundingKeyAddress: string;
  fundingAddress: string;
  operatorPubkey: string;
  fundingPubkey: string;
  residualAddress: string;
  depositorAddress: string;
  amount: string;
  network: string;
}

export async function buildBitvmDlcSetupBlueprint(
  config: IBitvmDlcSetupConfig,
): Promise<IBitvmDlcSetupBlueprint> {
  const freshFundingAddressRes = await smartRpc(
    'getnewaddress',
    [config.walletLabel || `bitvm-dlc-${Date.now()}`],
    false,
  );
  const fundingKeyAddress = String(freshFundingAddressRes?.data || '');
  if (!fundingKeyAddress) {
    throw new Error(freshFundingAddressRes?.error || 'Failed to allocate funding address.');
  }

  const operatorInfoRes = await smartRpc('getaddressinfo', [config.adminAddress], false);
  const fundingInfoRes = await smartRpc('getaddressinfo', [fundingKeyAddress], false);
  const operatorPubkey = String(operatorInfoRes?.data?.pubkey || '');
  const fundingPubkey = String(fundingInfoRes?.data?.pubkey || '');
  if (!operatorPubkey || !fundingPubkey) {
    throw new Error('Failed to resolve pubkeys for BitVM contract address.');
  }

  const multisigRes = await computeMultisigNative(2, [operatorPubkey, fundingPubkey], config.network);
  const fundingAddress = String(multisigRes?.address || '');
  if (!fundingAddress) {
    throw new Error('Failed to derive BitVM contract address.');
  }

  const setupId = `bitvm-${Date.now()}-${fundingKeyAddress.slice(-8)}`;
  const contractId = `${config.contractId}:${setupId}`;

  return {
    kind: 'bitvm-dlc-setup',
    setupId,
    contractId,
    templateId: config.templateId,
    templateHash: config.templateHash,
    operatorAddress: config.adminAddress,
    fundingKeyAddress,
    fundingAddress,
    operatorPubkey,
    fundingPubkey,
    residualAddress: config.vaultAddress || config.adminAddress,
    depositorAddress: config.depositorAddress,
    amount: String(config.amount),
    network: config.network,
  };
}
