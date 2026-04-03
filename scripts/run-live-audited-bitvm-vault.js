const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const { ECPairFactory } = require('ecpair');

const ECPair = ECPairFactory(ecc);
const stateOracle = require('C:\\projects\\tradelayer.js\\src\\stateOracle.js');
const dbInstance = require('C:\\projects\\tradelayer.js\\src\\db.js');

const NETWORK = {
  messagePrefix: '\x19Litecoin Signed Message:\n',
  bech32: 'tltc',
  bip32: {
    public: 0x043587cf,
    private: 0x04358394
  },
  pubKeyHash: 0x6f,
  scriptHash: 0x3a,
  wif: 0xef
};

const RPC_HOST = process.env.LTC_RPC_HOST || '127.0.0.1';
const RPC_PORT = Number(process.env.LTC_RPC_PORT || '19332');
const RPC_USER = process.env.LTC_RPC_USER || 'user';
const RPC_PASS = process.env.LTC_RPC_PASS || 'pass';
const WALLET = process.env.LTC_WALLET || 'tl-wallet';

const OPERATOR_LABEL = process.env.BITVM_OPERATOR_LABEL || 'm1-20260329-114821-operator';
const ORACLE_LABEL = process.env.BITVM_ORACLE_LABEL || 'm1-20260329-114821-oracle';
const RESIDUAL_LABEL = process.env.BITVM_RESIDUAL_LABEL || 'm1-20260329-114821-residual';

const FUNDING_SATS = Number(process.env.BITVM_FUNDING_SATS || '120000');
const ORACLE_PAYOUT_SATS = Number(process.env.BITVM_ORACLE_PAYOUT_SATS || '70000');
const RESIDUAL_PAYOUT_SATS = Number(process.env.BITVM_RESIDUAL_PAYOUT_SATS || '49000');
const SPEND_FEE_SATS = Number(process.env.BITVM_SPEND_FEE_SATS || '1000');
const TIMEOUT_DELAY_BLOCKS = Number(process.env.BITVM_TIMEOUT_DELAY_BLOCKS || '6');
const STATE_PROPERTY_ID = Number(process.env.BITVM_STATE_PROPERTY_ID || '73');
const STATE_FROM_BLOCK = Number(process.env.BITVM_STATE_FROM_BLOCK || '0');
const STATE_TO_BLOCK = Number(process.env.BITVM_STATE_TO_BLOCK || '0');
const STATE_BUCKET_SIZE = Number(process.env.BITVM_STATE_BUCKET_SIZE || '1');
const STATE_INCLUDE_ZERO = String(process.env.BITVM_STATE_INCLUDE_ZERO || 'true').toLowerCase() === 'true';
const STATE_OMIT_NOOP = String(process.env.BITVM_STATE_OMIT_NOOP || 'false').toLowerCase() === 'true';
const STATE_INCLUDE_OPS = String(process.env.BITVM_STATE_INCLUDE_OPS || 'issue,redeem,rpnl')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const DEFAULT_ARTIFACT_DIR = path.join(
  'C:\\projects\\UTXORef\\UTXO-Ref\\bitvm3\\utxo_referee\\artifacts'
);
const ARTIFACT_DIR = process.env.BITVM_ARTIFACT_DIR || DEFAULT_ARTIFACT_DIR;

function rpc(method, params = []) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '1.0', id: method, method, params });
    const req = http.request({
      hostname: RPC_HOST,
      port: RPC_PORT,
      method: 'POST',
      path: `/wallet/${encodeURIComponent(WALLET)}`,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: `Basic ${Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString('base64')}`
      }
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          if (json.error) {
            reject(new Error(json.error.message));
            return;
          }
          resolve(json.result);
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest();
}

function toLtc(sats) {
  return (Number(sats) / 1e8).toFixed(8);
}

function findAddressByLabelResult(byLabel) {
  const address = Object.keys(byLabel || {})[0];
  if (!address) {
    throw new Error('No address found for label');
  }
  return address;
}

async function getLabeledAddress(label) {
  const byLabel = await rpc('getaddressesbylabel', [label]);
  const address = findAddressByLabelResult(byLabel);
  const info = await rpc('getaddressinfo', [address]);
  const wif = await rpc('dumpprivkey', [address]);
  return {
    label,
    address,
    pubkeyHex: info.pubkey,
    keyPair: ECPair.fromWIF(wif, NETWORK)
  };
}

async function selectFundingUtxo(address) {
  const utxos = await rpc('listunspent', [1, 9999999, [address]]);
  const filtered = utxos
    .filter((utxo) => utxo.spendable && Math.round(Number(utxo.amount) * 1e8) > FUNDING_SATS + 2000)
    .sort((a, b) => Number(a.amount) - Number(b.amount));

  if (!filtered.length) {
    throw new Error(`No spendable UTXO found for ${address}`);
  }
  return filtered[0];
}

async function selectFundingSource(candidates) {
  const matches = [];
  for (const candidate of candidates) {
    const utxos = await rpc('listunspent', [1, 9999999, [candidate.address]]);
    for (const utxo of utxos) {
      const sats = Math.round(Number(utxo.amount) * 1e8);
      if (utxo.spendable && sats > FUNDING_SATS + 2000) {
        matches.push({
          owner: candidate,
          utxo,
          sats
        });
      }
    }
  }

  matches.sort((a, b) => a.sats - b.sats);
  if (!matches.length) {
    throw new Error('No spendable funding source found for configured labels');
  }
  return matches[0];
}

function witnessStackToScriptWitness(witness) {
  const bufferParts = [];

  function writeVarInt(i) {
    if (i < 0xfd) {
      return Buffer.from([i]);
    }
    if (i <= 0xffff) {
      const b = Buffer.allocUnsafe(3);
      b.writeUInt8(0xfd, 0);
      b.writeUInt16LE(i, 1);
      return b;
    }
    const b = Buffer.allocUnsafe(5);
    b.writeUInt8(0xfe, 0);
    b.writeUInt32LE(i, 1);
    return b;
  }

  bufferParts.push(writeVarInt(witness.length));
  for (const item of witness) {
    bufferParts.push(writeVarInt(item.length));
    bufferParts.push(item);
  }
  return Buffer.concat(bufferParts);
}

function compileVaultScript({ oracleHash, oraclePubkey, operatorPubkey, residualPubkey, timeoutHeight }) {
  return bitcoin.script.compile([
    bitcoin.opcodes.OP_IF,
    bitcoin.opcodes.OP_SHA256,
    oracleHash,
    bitcoin.opcodes.OP_EQUALVERIFY,
    oraclePubkey,
    bitcoin.opcodes.OP_CHECKSIGVERIFY,
    bitcoin.opcodes.OP_2,
    operatorPubkey,
    residualPubkey,
    bitcoin.opcodes.OP_2,
    bitcoin.opcodes.OP_CHECKMULTISIG,
    bitcoin.opcodes.OP_ELSE,
    bitcoin.script.number.encode(timeoutHeight),
    bitcoin.opcodes.OP_CHECKLOCKTIMEVERIFY,
    bitcoin.opcodes.OP_DROP,
    bitcoin.opcodes.OP_2,
    operatorPubkey,
    residualPubkey,
    bitcoin.opcodes.OP_2,
    bitcoin.opcodes.OP_CHECKMULTISIG,
    bitcoin.opcodes.OP_ENDIF
  ]);
}

async function buildCanonicalStateBinding({
  propertyId,
  addresses,
  fromBlock,
  toBlock,
  bucketSize,
  includeZero,
  omitNoOpAddresses,
  includeOps
}) {
  const primaryPayload = await stateOracle.buildAddressDailyPayload({
    propertyId,
    addresses,
    fromBlock,
    toBlock,
    bucketSize,
    includeZero,
    omitNoOpAddresses,
    includeOps
  });
  const primaryB64 = stateOracle.encodeBalancePayload(primaryPayload);
  const primaryPayloadBytes = Buffer.from(primaryB64, 'base64');
  const primaryHashHex = stateOracle.payloadHashFromB64(primaryB64);
  const primaryDigestEnvelope = {
    schema: 'tl-state-oracle-daily-digest-v1',
    propertyId,
    payloadHashHex: primaryHashHex,
    windowStartBlock: fromBlock,
    windowEndBlock: toBlock,
    rowCount: primaryPayload.rowCount,
    selectedAddresses: addresses
  };
  const primaryPreimage = Buffer.from(JSON.stringify(primaryDigestEnvelope));
  if (primaryPayload.rowCount > 0 && primaryPreimage.length <= 500) {
    return {
      payload: primaryPayload,
      payloadB64: primaryB64,
      payloadBytes: primaryPayloadBytes,
      preimage: primaryPreimage,
      payloadHashHex: primaryHashHex,
      witnessEnvelope: primaryDigestEnvelope,
      selectedAddresses: addresses,
      fromBlock,
      toBlock,
      compacted: false,
      witnessMode: 'digest-envelope'
    };
  }

  const deltaDB = await dbInstance.getDatabase('tallyMapDelta');
  const query = {
    'data.property': Number(propertyId),
    'data.address': { $in: addresses.map((value) => String(value)) }
  };
  const rows = await deltaDB.findAsync(query);
  const candidates = rows
    .map((row) => row?.data || row || {})
    .filter((row) => row && row.address && Number(row.block || 0) > 0)
    .sort((a, b) => Number(b.block || 0) - Number(a.block || 0));

  const seen = new Set();
  for (const row of candidates) {
    const address = String(row.address);
    const block = Number(row.block || 0);
    const key = `${address}:${block}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const payload = await stateOracle.buildAddressDailyPayload({
      propertyId,
      addresses: [address],
      fromBlock: block,
      toBlock: block,
      bucketSize,
      includeZero: false,
      omitNoOpAddresses: true,
      includeOps
    });
    if (!payload.rowCount) continue;
    const payloadB64 = stateOracle.encodeBalancePayload(payload);
    const payloadBytes = Buffer.from(payloadB64, 'base64');
    const payloadHashHex = stateOracle.payloadHashFromB64(payloadB64);
    const witnessEnvelope = {
      schema: 'tl-state-oracle-daily-digest-v1',
      propertyId,
      payloadHashHex,
      windowStartBlock: block,
      windowEndBlock: block,
      rowCount: payload.rowCount,
      selectedAddresses: [address]
    };
    const preimage = Buffer.from(JSON.stringify(witnessEnvelope));
    if (preimage.length <= 500) {
      return {
        payload,
        payloadB64,
        payloadBytes,
        preimage,
        payloadHashHex,
        witnessEnvelope,
        selectedAddresses: [address],
        fromBlock: block,
        toBlock: block,
        compacted: true,
        witnessMode: 'digest-envelope'
      };
    }
  }

  throw new Error('Unable to build a canonical daily digest envelope that fits witness push limits');
}

function extractSigMap(partialSig) {
  const map = new Map();
  for (const sig of partialSig || []) {
    map.set(sig.pubkey.toString('hex'), sig.signature);
  }
  return map;
}

async function main() {
  if (ORACLE_PAYOUT_SATS + RESIDUAL_PAYOUT_SATS + SPEND_FEE_SATS !== FUNDING_SATS) {
    throw new Error('Funding amount must equal oracle payout + residual payout + spend fee');
  }

  const chainInfo = await rpc('getblockchaininfo');
  const height = await rpc('getblockcount');
  const timeoutHeight = height + TIMEOUT_DELAY_BLOCKS;

  const operator = await getLabeledAddress(OPERATOR_LABEL);
  const oracle = await getLabeledAddress(ORACLE_LABEL);
  const residual = await getLabeledAddress(RESIDUAL_LABEL);
  const stateAddresses = Array.from(new Set([
    operator.address,
    oracle.address,
    residual.address,
    ...String(process.env.BITVM_STATE_ADDRESSES || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  ]));
  const effectiveToBlock = STATE_TO_BLOCK > 0 ? STATE_TO_BLOCK : height;
  const effectiveFromBlock = STATE_FROM_BLOCK > 0 ? STATE_FROM_BLOCK : Math.max(0, effectiveToBlock - 1);
  const stateBinding = await buildCanonicalStateBinding({
    propertyId: STATE_PROPERTY_ID,
    addresses: stateAddresses,
    fromBlock: effectiveFromBlock,
    toBlock: effectiveToBlock,
    bucketSize: STATE_BUCKET_SIZE,
    includeZero: STATE_INCLUDE_ZERO,
    omitNoOpAddresses: STATE_OMIT_NOOP,
    includeOps: STATE_INCLUDE_OPS
  });
  const dailyPayload = stateBinding.payload;
  const dailyPayloadB64 = stateBinding.payloadB64;
  const oraclePreimage = stateBinding.preimage;
  const canonicalPayloadHashHex = stateBinding.payloadHashHex;
  const oracleHash = sha256(oraclePreimage);
  const oracleHashHex = oracleHash.toString('hex');

  const witnessScript = compileVaultScript({
      oracleHash,
    oraclePubkey: Buffer.from(oracle.pubkeyHex, 'hex'),
    operatorPubkey: Buffer.from(operator.pubkeyHex, 'hex'),
    residualPubkey: Buffer.from(residual.pubkeyHex, 'hex'),
    timeoutHeight
  });

  const vaultPayment = bitcoin.payments.p2wsh({
    redeem: { output: witnessScript, network: NETWORK },
    network: NETWORK
  });

  const fundingSource = await selectFundingSource([operator, residual, oracle]);
  const fundingInput = fundingSource.utxo;
  const fundingInputSats = fundingSource.sats;

  const funded = await rpc('walletcreatefundedpsbt', [[{
    txid: fundingInput.txid,
    vout: fundingInput.vout
  }], {
    [vaultPayment.address]: toLtc(FUNDING_SATS)
  }, 0, {
    add_inputs: false,
    lockUnspents: false,
    includeWatching: true,
    changeAddress: fundingSource.owner.address
  }, true]);

  const processed = await rpc('walletprocesspsbt', [funded.psbt, true, 'ALL', true]);
  const finalized = await rpc('finalizepsbt', [processed.psbt, true]);
  if (!finalized.complete || !finalized.hex) {
    throw new Error('Failed to finalize funding PSBT');
  }
  const fundingTxid = await rpc('sendrawtransaction', [finalized.hex]);
  const fundingTx = await rpc('getrawtransaction', [fundingTxid, true]);
  const fundingVout = fundingTx.vout.findIndex((vout) => {
    const addresses = (vout.scriptPubKey && vout.scriptPubKey.addresses) || [];
    return addresses.includes(vaultPayment.address);
  });

  if (fundingVout < 0) {
    throw new Error('Could not find vault output in funding transaction');
  }

  const fundingOutput = fundingTx.vout[fundingVout];
  const fundingValueSats = Math.round(Number(fundingOutput.value) * 1e8);

  const oracleSpendPsbt = new bitcoin.Psbt({ network: NETWORK });
  oracleSpendPsbt.addInput({
    hash: fundingTxid,
    index: fundingVout,
    witnessUtxo: {
      script: Buffer.from(fundingOutput.scriptPubKey.hex, 'hex'),
      value: fundingValueSats
    },
    witnessScript
  });
  oracleSpendPsbt.addOutput({ address: operator.address, value: ORACLE_PAYOUT_SATS });
  oracleSpendPsbt.addOutput({ address: residual.address, value: RESIDUAL_PAYOUT_SATS });
  oracleSpendPsbt.signInput(0, operator.keyPair);
  oracleSpendPsbt.signInput(0, residual.keyPair);
  oracleSpendPsbt.signInput(0, oracle.keyPair);
  oracleSpendPsbt.finalizeInput(0, (_index, input) => {
    const sigMap = extractSigMap(input.partialSig);
    const finalScriptWitness = witnessStackToScriptWitness([
      Buffer.alloc(0),
      sigMap.get(operator.pubkeyHex),
      sigMap.get(residual.pubkeyHex),
      sigMap.get(oracle.pubkeyHex),
      oraclePreimage,
      Buffer.from([1]),
      witnessScript
    ]);
    return { finalScriptWitness };
  });
  const oracleSpendTx = oracleSpendPsbt.extractTransaction();
  const oracleSpendHex = oracleSpendTx.toHex();
  const oracleSpendTxid = await rpc('sendrawtransaction', [oracleSpendHex]);

  const timeoutSpendPsbt = new bitcoin.Psbt({ network: NETWORK });
  timeoutSpendPsbt.setLocktime(timeoutHeight);
  timeoutSpendPsbt.addInput({
    hash: fundingTxid,
    index: fundingVout,
    sequence: 0xfffffffe,
    witnessUtxo: {
      script: Buffer.from(fundingOutput.scriptPubKey.hex, 'hex'),
      value: fundingValueSats
    },
    witnessScript
  });
  timeoutSpendPsbt.addOutput({
    address: residual.address,
    value: FUNDING_SATS - SPEND_FEE_SATS
  });
  timeoutSpendPsbt.signInput(0, operator.keyPair);
  timeoutSpendPsbt.signInput(0, residual.keyPair);
  timeoutSpendPsbt.finalizeInput(0, (_index, input) => {
    const sigMap = extractSigMap(input.partialSig);
    const finalScriptWitness = witnessStackToScriptWitness([
      Buffer.alloc(0),
      sigMap.get(operator.pubkeyHex),
      sigMap.get(residual.pubkeyHex),
      Buffer.alloc(0),
      witnessScript
    ]);
    return { finalScriptWitness };
  });
  const timeoutSpendTx = timeoutSpendPsbt.extractTransaction();

  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const artifact = {
    kind: 'bitvm_live_audited_vault',
    createdAt: new Date().toISOString(),
    chain: {
      network: chainInfo.chain,
      rpcHost: RPC_HOST,
      rpcPort: RPC_PORT,
      height
    },
    roles: {
      operator: { label: operator.label, address: operator.address, pubkeyHex: operator.pubkeyHex },
      oracle: { label: oracle.label, address: oracle.address, pubkeyHex: oracle.pubkeyHex },
      residual: { label: residual.label, address: residual.address, pubkeyHex: residual.pubkeyHex }
    },
    fundingInput: {
      address: fundingSource.owner.address,
      label: fundingSource.owner.label,
      txid: fundingInput.txid,
      vout: fundingInput.vout,
      valueSats: fundingInputSats
    },
    stateOracle: {
      propertyId: STATE_PROPERTY_ID,
      requestedAddresses: stateAddresses,
      selectedAddresses: stateBinding.selectedAddresses,
      requestedFromBlock: effectiveFromBlock,
      requestedToBlock: effectiveToBlock,
      fromBlock: stateBinding.fromBlock,
      toBlock: stateBinding.toBlock,
      includeOps: STATE_INCLUDE_OPS,
      compactedForWitness: stateBinding.compacted,
      witnessMode: stateBinding.witnessMode,
      witnessEnvelope: stateBinding.witnessEnvelope,
      payload: dailyPayload,
      payloadB64: dailyPayloadB64,
      payloadByteLength: stateBinding.payloadBytes.length,
      payloadHashHex: canonicalPayloadHashHex
    },
    oraclePreimageHex: oraclePreimage.toString('hex'),
    oracleHashHex,
    timeoutHeight,
    vault: {
      address: vaultPayment.address,
      witnessScriptHex: witnessScript.toString('hex'),
      fundingTxid,
      fundingVout,
      fundingValueSats,
      fundingScriptPubKeyHex: fundingOutput.scriptPubKey.hex
    },
    oracleSpend: {
      txid: oracleSpendTxid,
      hex: oracleSpendHex,
      outputs: [
        { address: operator.address, valueSats: ORACLE_PAYOUT_SATS },
        { address: residual.address, valueSats: RESIDUAL_PAYOUT_SATS }
      ]
    },
    timeoutSpend: {
      txid: timeoutSpendTx.getId(),
      hex: timeoutSpendTx.toHex(),
      outputs: [
        { address: residual.address, valueSats: FUNDING_SATS - SPEND_FEE_SATS }
      ]
    }
  };

  const artifactPath = path.join(ARTIFACT_DIR, 'bitvm_live_audited_vault_latest.json');
  fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));

  console.log('[bitvm-live-audited-vault] SUCCESS');
  console.log(JSON.stringify({
    vaultAddress: vaultPayment.address,
    fundingTxid,
    fundingVout,
    fundingValueSats,
    oracleSpendTxid,
    timeoutSpendTxid: timeoutSpendTx.getId(),
    witnessScriptHex: witnessScript.toString('hex'),
    oracleHashHex,
    artifactPath
  }, null, 2));
}

main().catch((error) => {
  console.error('[bitvm-live-audited-vault] failed:', error && error.stack ? error.stack : String(error));
  process.exit(1);
});
