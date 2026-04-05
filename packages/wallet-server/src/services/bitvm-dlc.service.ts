import BigNumber from 'bignumber.js';
import { computeMultisigNative, smartRpc } from "./tx-builder.service";

function toSats(amount: number | string): BigNumber {
  return new BigNumber(amount || 0).times(1e8).integerValue(BigNumber.ROUND_DOWN);
}

function satsToLtcString(amountSats: BigNumber.Value): string {
  return new BigNumber(amountSats || 0).dividedBy(1e8).toFixed(8);
}

function clampNonNegInt(value: number | string | undefined | null): number {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

export interface IBitvmDlcSetupConfig {
  adminAddress: string;
  depositorAddress: string;
  amount: number | string;
  templateId: string;
  templateHash: string;
  contractId: string;
  vaultAddress?: string;
  residualAddress?: string;
  feeAddress?: string;
  pnlEscrowAddress?: string;
  refundAddress?: string;
  rolloverAddress?: string;
  flatRecipientAddress?: string;
  pnlRecipientAddress?: string;
  feeRateBps?: number;
  pnlEscrowBps?: number;
  settlementSplitBps?: number;
  walletLabel?: string;
  network: string;
}

export interface IBitvmDlcRouteOutput {
  role: string;
  address: string;
  amountSats: string;
  amountLtc: string;
}

export interface IBitvmDlcRoutePath {
  pathId: string;
  kind: 'settlement' | 'refund' | 'roll' | 'escrow' | 'fee';
  routeAlias?: string;
  payoutRole: string;
  payoutAddress: string;
  payoutSats: string;
  residualAddress: string;
  residualSats: string;
  defaultOnExpiry: boolean;
  locktime?: number;
  nextContractId?: string;
}

export interface IBitvmDlcRoutePlan {
  fundingAmountSats: string;
  fundingAmountLtc: string;
  feeRateBps: number;
  pnlEscrowBps: number;
  settlementSplitBps: number;
  feeSats: string;
  feeLtc: string;
  pnlEscrowSats: string;
  pnlEscrowLtc: string;
  netFundingSats: string;
  netFundingLtc: string;
  settlementPoolSats: string;
  settlementPoolLtc: string;
  flatPayoutSats: string;
  pnlPayoutSats: string;
  flatResidualSats: string;
  pnlResidualSats: string;
  refundSats: string;
  refundLtc: string;
  rolloverSats: string;
  rolloverLtc: string;
  outputs: IBitvmDlcRouteOutput[];
  paths: IBitvmDlcRoutePath[];
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
  feeAddress: string;
  pnlEscrowAddress: string;
  refundAddress: string;
  rolloverAddress: string;
  routePlan: IBitvmDlcRoutePlan;
}

function buildRoutePlan(
  config: IBitvmDlcSetupConfig,
  fundingAmount: BigNumber,
  fundingAddress: string,
): IBitvmDlcRoutePlan {
  const feeRateBps = clampNonNegInt(config.feeRateBps ?? 24);
  const pnlEscrowBps = clampNonNegInt(config.pnlEscrowBps ?? 1000);
  const settlementSplitBps = clampNonNegInt(config.settlementSplitBps ?? 5000);

  const feeSats = fundingAmount.times(feeRateBps).dividedToIntegerBy(10000);
  const netFunding = BigNumber.max(new BigNumber(0), fundingAmount.minus(feeSats));
  const pnlEscrowSats = netFunding.times(pnlEscrowBps).dividedToIntegerBy(10000);
  const settlementPool = BigNumber.max(new BigNumber(0), netFunding.minus(pnlEscrowSats));
  const flatPayout = settlementPool.times(settlementSplitBps).dividedToIntegerBy(10000);
  const pnlPayout = BigNumber.max(new BigNumber(0), settlementPool.minus(flatPayout));
  const flatResidual = BigNumber.max(new BigNumber(0), settlementPool.minus(flatPayout));
  const pnlResidual = BigNumber.max(new BigNumber(0), settlementPool.minus(pnlPayout));
  const refundSats = settlementPool;
  const rolloverSats = settlementPool;

  const feeAddress = config.feeAddress || config.residualAddress || config.vaultAddress || config.adminAddress;
  const pnlEscrowAddress = config.pnlEscrowAddress || config.residualAddress || config.vaultAddress || config.adminAddress;
  const refundAddress = config.refundAddress || config.depositorAddress;
  const rolloverAddress = config.rolloverAddress || config.residualAddress || config.vaultAddress || config.adminAddress;
  const flatRecipientAddress = config.flatRecipientAddress || config.depositorAddress;
  const pnlRecipientAddress = config.pnlRecipientAddress || config.residualAddress || config.vaultAddress || config.adminAddress;
  const residualAddress = config.residualAddress || config.vaultAddress || config.adminAddress;

  const outputs: IBitvmDlcRouteOutput[] = [
    {
      role: 'contract-funding',
      address: String(fundingAddress || ''),
      amountSats: settlementPool.toFixed(0),
      amountLtc: satsToLtcString(settlementPool),
    },
  ];

  if (feeSats.gt(0)) {
    outputs.push({
      role: 'fee',
      address: feeAddress,
      amountSats: feeSats.toFixed(0),
      amountLtc: satsToLtcString(feeSats),
    });
  }

  if (pnlEscrowSats.gt(0)) {
    outputs.push({
      role: 'pnl-escrow',
      address: pnlEscrowAddress,
      amountSats: pnlEscrowSats.toFixed(0),
      amountLtc: satsToLtcString(pnlEscrowSats),
    });
  }

  return {
    fundingAmountSats: fundingAmount.toFixed(0),
    fundingAmountLtc: satsToLtcString(fundingAmount),
    feeRateBps,
    pnlEscrowBps,
    settlementSplitBps,
    feeSats: feeSats.toFixed(0),
    feeLtc: satsToLtcString(feeSats),
    pnlEscrowSats: pnlEscrowSats.toFixed(0),
    pnlEscrowLtc: satsToLtcString(pnlEscrowSats),
    netFundingSats: netFunding.toFixed(0),
    netFundingLtc: satsToLtcString(netFunding),
    settlementPoolSats: settlementPool.toFixed(0),
    settlementPoolLtc: satsToLtcString(settlementPool),
    flatPayoutSats: flatPayout.toFixed(0),
    pnlPayoutSats: pnlPayout.toFixed(0),
    flatResidualSats: flatResidual.toFixed(0),
    pnlResidualSats: pnlResidual.toFixed(0),
    refundSats: refundSats.toFixed(0),
    refundLtc: satsToLtcString(refundSats),
    rolloverSats: rolloverSats.toFixed(0),
    rolloverLtc: satsToLtcString(rolloverSats),
    outputs,
    paths: [
      {
        pathId: 'settle-gain',
        kind: 'settlement',
        routeAlias: 'flat',
        payoutRole: 'gain-recipient',
        payoutAddress: flatRecipientAddress,
        payoutSats: flatPayout.toFixed(0),
        residualAddress,
        residualSats: flatResidual.toFixed(0),
        defaultOnExpiry: false,
      },
      {
        pathId: 'settle-loss',
        kind: 'settlement',
        routeAlias: 'pnl',
        payoutRole: 'loss-recipient',
        payoutAddress: pnlRecipientAddress,
        payoutSats: pnlPayout.toFixed(0),
        residualAddress,
        residualSats: pnlResidual.toFixed(0),
        defaultOnExpiry: false,
      },
      {
        pathId: 'roll',
        kind: 'roll',
        routeAlias: 'timeout-refund',
        payoutRole: 'rollover-recipient',
        payoutAddress: rolloverAddress,
        payoutSats: rolloverSats.toFixed(0),
        residualAddress: rolloverAddress,
        residualSats: rolloverSats.toFixed(0),
        defaultOnExpiry: true,
      },
      {
        pathId: 'pnl-escrow',
        kind: 'escrow',
        payoutRole: 'pnl-escrow',
        payoutAddress: pnlEscrowAddress,
        payoutSats: pnlEscrowSats.toFixed(0),
        residualAddress: pnlEscrowAddress,
        residualSats: pnlEscrowSats.toFixed(0),
        defaultOnExpiry: false,
      },
      {
        pathId: 'fee',
        kind: 'fee',
        payoutRole: 'fee',
        payoutAddress: feeAddress,
        payoutSats: feeSats.toFixed(0),
        residualAddress: feeAddress,
        residualSats: feeSats.toFixed(0),
        defaultOnExpiry: false,
      },
    ],
  };
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
  const contractId = config.contractId;
  const fundingAmount = toSats(config.amount);
  const routePlan = buildRoutePlan({
    ...config,
    adminAddress: config.adminAddress,
    depositorAddress: config.depositorAddress,
    amount: fundingAmount.dividedBy(1e8).toString(10),
    vaultAddress: config.vaultAddress || config.adminAddress,
  }, fundingAmount, fundingAddress);

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
    residualAddress: config.residualAddress || config.vaultAddress || config.adminAddress,
    depositorAddress: config.depositorAddress,
    amount: String(config.amount),
    network: config.network,
    feeAddress: config.feeAddress || config.vaultAddress || config.adminAddress,
    pnlEscrowAddress: config.pnlEscrowAddress || config.vaultAddress || config.adminAddress,
    refundAddress: config.refundAddress || config.depositorAddress,
    rolloverAddress: config.rolloverAddress || config.vaultAddress || config.adminAddress,
    routePlan,
  };
}
