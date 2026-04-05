const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const { ECPairFactory } = require('ecpair');

const ECPair = ECPairFactory(ecc);

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
const WALLET = process.env.LTC_WALLET || 'wallet.dat';
const TIMEOUT_OFFSET = Number(process.env.BITVM_TIMEOUT_OFFSET || '2');
const MIN_FUNDING_CONFIRMATIONS = Number(process.env.BITVM_MIN_FUNDING_CONFIRMATIONS || '1');

const ARTIFACT_PATH = process.env.BITVM_EXPIRY_ARTIFACT
  || 'C:\\projects\\UTXORef\\UTXO-Ref\\bitvm3\\utxo_referee\\artifacts\\m1_expiry_redemption_latest.json';
const DRAFT_PATH = process.env.BITVM_SETTLEMENT_DRAFT_PATH
  || 'C:\\projects\\UTXORef\\UTXO-Ref\\bitvm3\\utxo_referee\\artifacts\\m1_dlc_draft_latest.json';
const PROOF_OUT_PATH = process.env.BITVM_EXPIRY_TIMEOUT_PROOF_OUT
  || 'C:\\projects\\UTXORef\\UTXO-Ref\\bitvm3\\utxo_referee\\artifacts\\m1_expiry_timeout_testnet_proof.json';

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

function buildDeltaPreimage(delta) {
  const payload = {
    epochId: delta.epochId !== undefined && delta.epochId !== null ? String(delta.epochId) : null,
    route: delta.route || 'roll',
    depositedSats: String(delta.depositedSats),
    redeemedSats: String(delta.redeemedSats),
    pnlReferenceSats: String(delta.pnlReferenceSats),
    realizedPnlSats: String(delta.realizedPnlSats),
    pnlGainSats: String(delta.pnlGainSats),
    pnlLossSats: String(delta.pnlLossSats),
    feeSats: String(delta.feeSats),
    netDeltaSats: String(delta.netDeltaSats),
    maturityHeight: delta.maturityHeight !== undefined && delta.maturityHeight !== null ? String(delta.maturityHeight) : null,
    expiryHeight: delta.expiryHeight !== undefined && delta.expiryHeight !== null ? String(delta.expiryHeight) : null,
    oracleEventId: delta.oracleEventId || null,
    oracleDigestHex: delta.oracleDigestHex || null,
    note: delta.note || null
  };
  return Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
}

function witnessStackToScriptWitness(witness) {
  const bufferParts = [];

  function writeVarInt(i) {
    if (i < 0xfd) return Buffer.from([i]);
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

function compileTimeoutVaultScript({ oracleHash, oraclePubkey, operatorPubkey, residualPubkey, timeoutHeight }) {
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
    bitcoin.opcodes.OP_DROP,
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

async function loadWalletAddress(label) {
  const address = await rpc('getnewaddress', [label]);
  const info = await rpc('getaddressinfo', [address]);
  const wif = await rpc('dumpprivkey', [address]);
  return {
    label,
    address,
    pubkeyHex: info.pubkey,
    keyPair: ECPair.fromWIF(wif, NETWORK)
  };
}

async function waitForHeight(targetHeight, timeoutMs = 15 * 60 * 1000, pollMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const height = Number(await rpc('getblockcount'));
    if (height >= targetHeight) {
      return height;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Timed out waiting for chain height ${targetHeight}`);
}

async function waitForConfirmations(txid, minConfirmations = 1, timeoutMs = 15 * 60 * 1000, pollMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const tx = await rpc('gettransaction', [txid]);
      const confirmations = Number(tx?.confirmations || 0);
      if (confirmations >= minConfirmations) {
        return confirmations;
      }
    } catch (_error) {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Timed out waiting for ${minConfirmations} confirmations on ${txid}`);
}

async function main() {
  const chainInfo = await rpc('getblockchaininfo');
  const startHeight = Number(await rpc('getblockcount'));
  const artifact = JSON.parse(fs.readFileSync(ARTIFACT_PATH, 'utf8'));
  const draft = fs.existsSync(DRAFT_PATH) ? JSON.parse(fs.readFileSync(DRAFT_PATH, 'utf8')) : null;
  const delta = artifact?.witnessBlob?.deltaAnnotation || artifact?.deltas || null;
  if (!delta) {
    throw new Error(`No delta annotation found in ${ARTIFACT_PATH}`);
  }
  const committedRouting = artifact?.routingCommitments || draft?.contract?.settlement?.roll || {};

  const deltaPreimage = buildDeltaPreimage(delta);
  const oracleHash = sha256(deltaPreimage);
  const oracleHashHex = oracleHash.toString('hex');

  const operator = await loadWalletAddress('bitvm-expiry-timeout-operator');
  const oracle = await loadWalletAddress('bitvm-expiry-timeout-oracle');
  const residual = await loadWalletAddress('bitvm-expiry-timeout-residual');
  const recipient = await loadWalletAddress('bitvm-expiry-timeout-recipient');
  const timeoutHeight = startHeight + TIMEOUT_OFFSET;
  const vaultScript = compileTimeoutVaultScript({
    oracleHash,
    oraclePubkey: Buffer.from(oracle.pubkeyHex, 'hex'),
    operatorPubkey: Buffer.from(operator.pubkeyHex, 'hex'),
    residualPubkey: Buffer.from(residual.pubkeyHex, 'hex'),
    timeoutHeight
  });

  const vaultPayment = bitcoin.payments.p2wsh({
    redeem: { output: vaultScript, network: NETWORK },
    network: NETWORK
  });
  if (!vaultPayment.address || !vaultPayment.output) {
    throw new Error('Failed to derive vault payment');
  }

  const fundingAmountSats = 900000;
  const fundingAmountLtc = (fundingAmountSats / 1e8).toFixed(8);

  const funded = await rpc('walletcreatefundedpsbt', [[], {
    [vaultPayment.address]: fundingAmountLtc
  }, 0, {
    add_inputs: true,
    includeWatching: true,
    changeAddress: recipient.address
  }, true]);
  if (!funded?.psbt) {
    throw new Error('Failed to create funding PSBT');
  }

  const processed = await rpc('walletprocesspsbt', [funded.psbt, true, 'ALL', true]);
  const finalized = await rpc('finalizepsbt', [processed.psbt, true]);
  if (!finalized.complete || !finalized.hex) {
    throw new Error('Failed to finalize funding PSBT');
  }
  const fundingTxid = await rpc('sendrawtransaction', [finalized.hex]);
  if (MIN_FUNDING_CONFIRMATIONS > 0) {
    await waitForConfirmations(fundingTxid, MIN_FUNDING_CONFIRMATIONS);
  }
  const fundingTx = await rpc('getrawtransaction', [fundingTxid, true]);
  const fundingVout = fundingTx.vout.findIndex((vout) => {
    const addresses = (vout.scriptPubKey && vout.scriptPubKey.addresses) || [];
    return addresses.includes(vaultPayment.address);
  });
  if (fundingVout < 0) {
    throw new Error('Could not find vault output in funding transaction');
  }

  const currentHeight = TIMEOUT_OFFSET > 0
    ? await waitForHeight(timeoutHeight + 1)
    : Number(await rpc('getblockcount'));

  const fundingOutput = fundingTx.vout[fundingVout];
  const fundingValueSats = Math.round(Number(fundingOutput.value) * 1e8);
  const redeemedSats = Number(artifact?.redemption?.amountSats || delta.redeemedSats || 0);
  const residualSats = Number(artifact?.redemption?.remainingBalanceSats || delta.netDeltaSats || 0);
  const committedWinnerAddress = committedRouting?.winnerAddress || recipient.address;
  const committedRefundAddress = committedRouting?.refundAddress || residual.address;
  const committedDustAddress = committedRouting?.dustAddress || null;
  const dustCarrySats = Number(artifact?.settlementBreakdown?.dustCarrySats || artifact?.redemption?.dustCarrySats || 0);
  const outputSumSats = redeemedSats + residualSats;
  const feeBufferSats = fundingValueSats - outputSumSats - dustCarrySats;
  if (feeBufferSats < 0) {
    throw new Error(`Funding output too small: input=${fundingValueSats} outputs=${outputSumSats + dustCarrySats}`);
  }

  const timeoutPsbt = new bitcoin.Psbt({ network: NETWORK });
  timeoutPsbt.setLocktime(timeoutHeight);
  timeoutPsbt.addInput({
    hash: fundingTxid,
    index: fundingVout,
    sequence: 0xfffffffe,
    witnessUtxo: {
      script: Buffer.from(fundingOutput.scriptPubKey.hex, 'hex'),
      value: fundingValueSats
    },
    witnessScript: vaultScript
  });
  timeoutPsbt.addOutput({ address: committedWinnerAddress, value: redeemedSats });
  if (residualSats > 0) {
    timeoutPsbt.addOutput({ address: committedRefundAddress, value: residualSats });
  }
  if (dustCarrySats > 0) {
    if (!committedDustAddress) {
      throw new Error('dustCarrySats is positive but no committed dust address was provided');
    }
    timeoutPsbt.addOutput({ address: committedDustAddress, value: dustCarrySats });
  }

  timeoutPsbt.signInput(0, operator.keyPair);
  timeoutPsbt.signInput(0, residual.keyPair);
  timeoutPsbt.finalizeInput(0, (_index, input) => {
    const sigMap = new Map((input.partialSig || []).map((sig) => [sig.pubkey.toString('hex'), sig.signature]));
    const finalScriptWitness = witnessStackToScriptWitness([
      Buffer.alloc(0),
      sigMap.get(operator.pubkeyHex),
      sigMap.get(residual.pubkeyHex),
      deltaPreimage,
      Buffer.alloc(0),
      vaultScript
    ]);
    return { finalScriptWitness };
  });

  const timeoutTx = timeoutPsbt.extractTransaction();
  const timeoutTxid = await rpc('sendrawtransaction', [timeoutTx.toHex()]);

  const proof = {
    kind: 'bitvm-expiry-timeout-proof',
    createdAt: new Date().toISOString(),
    chain: {
      network: chainInfo.chain,
      startHeight,
      currentHeight,
      timeoutHeight,
      timeoutOffset: TIMEOUT_OFFSET,
      minFundingConfirmations: MIN_FUNDING_CONFIRMATIONS
    },
    artifactPath: ARTIFACT_PATH,
    operator: { address: operator.address, pubkeyHex: operator.pubkeyHex },
    oracle: { address: oracle.address, pubkeyHex: oracle.pubkeyHex },
    residual: { address: residual.address, pubkeyHex: residual.pubkeyHex },
    recipient: { address: recipient.address, pubkeyHex: recipient.pubkeyHex },
    committedRouting: {
      winnerRole: committedRouting?.winnerRole || null,
      winnerAddress: committedWinnerAddress,
      refundRole: committedRouting?.refundRole || null,
      refundAddress: committedRefundAddress,
      feeRole: committedRouting?.feeRole || null,
      feeAddress: committedRouting?.feeAddress || null,
      dustRole: committedRouting?.dustRole || null,
      dustAddress: committedDustAddress
    },
    artifact: {
      deposit: artifact.deposit,
      redemption: artifact.redemption,
      deltas: artifact.deltas,
      artifactHash: artifact.artifactHash
    },
    deltaPreimageHex: deltaPreimage.toString('hex'),
    oracleHashHex,
    vault: {
      address: vaultPayment.address,
      witnessScriptHex: vaultScript.toString('hex'),
      fundingTxid,
      fundingVout,
      fundingValueSats
    },
    timeoutSpend: {
      txid: timeoutTxid,
      hex: timeoutTx.toHex(),
      recipientSats: redeemedSats,
      residualSats,
      dustCarrySats,
      feeBufferSats
    }
  };

  fs.mkdirSync(path.dirname(PROOF_OUT_PATH), { recursive: true });
  fs.writeFileSync(PROOF_OUT_PATH, JSON.stringify(proof, null, 2));

  console.log('[bitvm-expiry-timeout-proof] SUCCESS');
  console.log(JSON.stringify({
    vaultAddress: vaultPayment.address,
    fundingTxid,
    timeoutTxid,
    timeoutHeight,
    currentHeight,
    proofPath: PROOF_OUT_PATH
  }, null, 2));
}

main().catch((error) => {
  console.error('[bitvm-expiry-timeout-proof] failed:', error && error.stack ? error.stack : String(error));
  process.exit(1);
});
