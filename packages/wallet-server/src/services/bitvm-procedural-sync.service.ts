import fs from 'fs';
import path from 'path';

type AnyRecord = Record<string, any>;

const BITVM_ARTIFACT_ROOT = process.env.BITVM_ARTIFACT_ROOT
  || 'C:\\projects\\UTXORef\\UTXO-Ref\\bitvm3\\utxo_referee\\artifacts';

const DEFAULT_RECEIPT_PROPERTY_ID = 380;
const DEFAULT_RECEIPT_TICKER = 'rLTC-SAT';

function safeJsonParse(value: string, fallback: any) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function readJson(filePath: string) {
  return safeJsonParse(fs.readFileSync(filePath, 'utf8'), null);
}

function readJsonLines(filePath: string): AnyRecord[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => safeJsonParse(line, null))
    .filter(Boolean);
}

function writeJsonLines(filePath: string, docs: AnyRecord[]) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = docs.map((doc) => JSON.stringify(doc)).join('\n');
  fs.writeFileSync(filePath, body ? `${body}\n` : '', 'utf8');
}

function upsertById(docs: AnyRecord[], nextDoc: AnyRecord) {
  const id = String(nextDoc?._id || '').trim();
  if (!id) {
    throw new Error('Document _id is required for sync upsert.');
  }
  const idx = docs.findIndex((doc) => String(doc?._id || '') === id);
  if (idx >= 0) {
    docs[idx] = { ...docs[idx], ...nextDoc };
  } else {
    docs.push(nextDoc);
  }
  return docs;
}

function referenceToken(value: string | number | null | undefined) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^\d+$/.test(raw)) return Number(raw).toString(36);
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function encodeAmountBase36(value: number) {
  const sats = Math.round(Number(value || 0) * 1e8);
  return sats.toString(36);
}

function roundLtc(valueSats: string | number | null | undefined) {
  const sats = Number(valueSats || 0);
  return Number((sats / 1e8).toFixed(8));
}

function getRepoRoot() {
  return process.env.TRADELAYER_WALLET_ROOT
    ? path.resolve(process.env.TRADELAYER_WALLET_ROOT)
    : 'C:\\Users\\Patri\\tradelayer-wallet';
}

function getDbRoot() {
  const override = process.env.TL_NEDB_ROOT;
  if (override) {
    return path.isAbsolute(override)
      ? override
      : path.join(getRepoRoot(), override);
  }
  return path.join(getRepoRoot(), 'dist', 'tradelayer', 'nedb-data');
}

function getDbFolderName() {
  const chain = String(process.env.CHAIN || 'LTC').trim().toLowerCase();
  const network = String(process.env.NETWORK || 'testnet').trim().toLowerCase();
  return `${chain}-${network.includes('main') ? 'main' : 'test'}`;
}

function getDbFile(name: string) {
  return path.join(getDbRoot(), getDbFolderName(), `${name}.db`);
}

function getArtifact(name: string) {
  const filePath = path.join(BITVM_ARTIFACT_ROOT, name);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing BitVM artifact: ${filePath}`);
  }
  return readJson(filePath);
}

export interface BitvmProceduralSyncParams {
  holderAddress?: string;
  propertyId?: number;
  state?: string;
}

export function syncBitvmProceduralState(params: BitvmProceduralSyncParams = {}) {
  const draft = getArtifact('m1_dlc_draft_latest.json');
  const expiry = getArtifact('m1_expiry_redemption_latest.json');

  const roleAddresses = draft?.roleSet?.addresses || {};
  const propertyId = Number(params.propertyId || DEFAULT_RECEIPT_PROPERTY_ID);
  const holderAddress = String(params.holderAddress || roleAddresses.alice || '').trim();
  const operatorAddress = String(roleAddresses.operator || '').trim();
  const oracleAddress = String(roleAddresses.oracle || '').trim();
  const residualAddress = String(roleAddresses.residual || '').trim();
  const templateId = String(draft?.template?.templateId || 'dlc-receipt-ltc-testnet-v1').trim();
  const templateHash = String(draft?.template?.templateHash || '').trim();
  const contractId = String(draft?.contract?.eventId || '').trim();
  const fundingTxid = String(expiry?.deposit?.txid || '').trim();
  const fundedAmountLtc = roundLtc(expiry?.redemption?.amountSats || expiry?.deposit?.amountSats || 0);
  const fundedAtBlock = Number(draft?.chain?.blockHeight || 0);
  const state = String(params.state || 'SETTLED').trim().toUpperCase();

  if (!holderAddress) {
    throw new Error('A holderAddress is required to sync the procedural receipt state.');
  }
  if (!operatorAddress) {
    throw new Error('Draft artifact is missing the operator address.');
  }
  if (!templateHash) {
    throw new Error('Draft artifact is missing the template hash.');
  }
  if (!contractId) {
    throw new Error('Draft artifact is missing the contract/event id.');
  }

  const propertyListPath = getDbFile('propertyList');
  const proceduralPath = getDbFile('procedural');
  const tallyPath = getDbFile('tallyMap');
  const txIndexPath = getDbFile('txIndex');

  const propertyDocs = readJsonLines(propertyListPath);
  const propertyIndexDoc = propertyDocs.find((doc) => String(doc?._id || '') === 'propertyIndex') || { _id: 'propertyIndex', value: '[]' };
  const propertyIndex = safeJsonParse(String(propertyIndexDoc.value || '[]'), []);
  const propertyEntry = [
    propertyId,
    {
      ticker: DEFAULT_RECEIPT_TICKER,
      totalInCirculation: fundedAmountLtc,
      type: 7,
      whitelistId: 0,
      issuer: operatorAddress,
      backupAddress: '',
      proceduralType: 1
    }
  ];
  const propertyIdx = propertyIndex.findIndex((entry: any[]) => Number(entry?.[0]) === propertyId);
  if (propertyIdx >= 0) {
    propertyIndex[propertyIdx] = propertyEntry;
  } else {
    propertyIndex.push(propertyEntry);
  }
  propertyIndexDoc.value = JSON.stringify(propertyIndex);
  upsertById(propertyDocs, propertyIndexDoc);
  writeJsonLines(propertyListPath, propertyDocs);

  const proceduralDocs = readJsonLines(proceduralPath);
  upsertById(proceduralDocs, {
    _id: `template-${templateId}`,
    type: 'template',
    templateId,
    templateRef: referenceToken(templateId),
    dlcHash: templateHash,
    templateHash,
    state: 'TEMPLATE'
  });
  upsertById(proceduralDocs, {
    _id: `contract-${contractId}`,
    type: 'contract',
    contractId,
    contractIdRef: referenceToken(contractId),
    templateId,
    templateRef: referenceToken(templateId),
    state,
    redeemAddress: holderAddress,
    fundedAmount: fundedAmountLtc,
    fundedAt: fundedAtBlock || null,
    fundingTxid,
    fundingPropertyId: propertyId,
    dlcHash: templateHash,
    settlementState: state,
    live: true
  });
  writeJsonLines(proceduralPath, proceduralDocs);

  const tallyDocs = readJsonLines(tallyPath);
  let tallyMapDoc = tallyDocs.find((doc) => String(doc?._id || '') === 'tallyMap');
  let tallyEntries = safeJsonParse(String(tallyMapDoc?.data || '[]'), []);
  const holderIdx = tallyEntries.findIndex((entry: any[]) => String(entry?.[0] || '') === holderAddress);
  const nextHolderBalances = holderIdx >= 0 && tallyEntries[holderIdx]?.[1]
    ? { ...tallyEntries[holderIdx][1] }
    : {};
  nextHolderBalances[String(propertyId)] = {
    amount: fundedAmountLtc,
    available: fundedAmountLtc,
    reserved: 0,
    margin: 0,
    vesting: 0,
    channelBalance: 0
  };
  if (holderIdx >= 0) {
    tallyEntries[holderIdx] = [holderAddress, nextHolderBalances];
  } else {
    tallyEntries.push([holderAddress, nextHolderBalances]);
  }
  tallyMapDoc = {
    _id: 'tallyMap',
    block: fundedAtBlock || tallyMapDoc?.block || 0,
    data: JSON.stringify(tallyEntries)
  };
  upsertById(tallyDocs, { _id: '$TLinit', initialized: true });
  upsertById(tallyDocs, tallyMapDoc);
  writeJsonLines(tallyPath, tallyDocs);

  const txDocs = readJsonLines(txIndexPath);
  const txid = fundingTxid || `bitvm-sync-${referenceToken(contractId)}`;
  const txDocId = `tx-${fundedAtBlock || 0}-${txid}`;
  upsertById(txDocs, {
    _id: txDocId,
    type: 11,
    valid: true,
    value: {
      sender: {
        senderAddress: operatorAddress,
        amount: roundLtc(expiry?.deposit?.amountSats || 0)
      },
      reference: [
        {
          address: holderAddress,
          satoshis: Number(expiry?.deposit?.amountSats || 0)
        }
      ],
      payload: [
        propertyId.toString(36),
        encodeAmountBase36(fundedAmountLtc),
        holderAddress,
        templateId,
        contractId,
        state,
        templateHash
      ].join(','),
      decodedParams: {
        dlcTemplateId: templateId,
        dlcContractId: contractId,
        settlementState: state,
        dlcHash: templateHash
      },
      marker: 'tl',
      txId: txid
    }
  });
  writeJsonLines(txIndexPath, txDocs);

  const summary = {
    propertyId,
    holderAddress,
    operatorAddress,
    oracleAddress,
    residualAddress,
    templateId,
    templateHash,
    contractId,
    fundingTxid,
    fundedAmountLtc,
    state,
    dbRoot: path.join(getDbRoot(), getDbFolderName())
  };

  const summaryPath = path.join(BITVM_ARTIFACT_ROOT, 'bitvm_procedural_sync_latest.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');

  return summary;
}
