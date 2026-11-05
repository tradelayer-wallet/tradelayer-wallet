//! BIP-322 "simple" message signatures for the orderbook login.
//!
//! The orderbook server asks a client to prove control of an address by signing a challenge
//! (`GET /auth/challenge`, `POST /auth/verify`). The signature is BIP-322 *simple*: the base64 of
//! the serialized witness stack of the virtual `to_sign` transaction, for the script types of the
//! wallet's addresses:
//!
//! * P2WPKH (`witness [sig, pubkey]`),
//! * P2SH-P2WPKH, the address type of the in-memory `tlk1:` keys (the same witness; the verifier
//!   rebuilds the redeem script from the witness public key and checks it against the address's
//!   script hash),
//! * P2TR key path (`witness [schnorr signature]`), which only the node wallet produces.
//!
//! P2PKH addresses have no witness and are signed with BIP-137 instead (the node's `signmessage`).
//!
//! This module is pure: it builds the two virtual transactions ([`to_spend`], [`to_sign`]), the
//! BIP-143 digest the key signs ([`sign_simple_wpkh`], for keys held in Rust), the PSBT the node
//! wallet signs ([`challenge_psbt`] and [`witness_of_signed_psbt`], for node-wallet addresses), and
//! in tests the verification the server performs ([`verify_simple`]).

use bitcoin::absolute::LockTime;
use bitcoin::bip32::{DerivationPath, Fingerprint};
use bitcoin::consensus::serialize;
use bitcoin::hashes::{sha256, Hash, HashEngine};
use bitcoin::opcodes::all::OP_RETURN;
use bitcoin::psbt::Psbt;
use bitcoin::script::Builder;
use bitcoin::secp256k1::{ecdsa, Message};
use bitcoin::sighash::{EcdsaSighashType, SighashCache};
use bitcoin::transaction::Version;
use bitcoin::{
    Amount, CompressedPublicKey, OutPoint, Script, ScriptBuf, Sequence, Transaction, TxIn, TxOut,
    Txid, Witness,
};

type R<T> = Result<T, String>;

/// The tag of BIP-322's message hash.
const TAG: &[u8] = b"BIP0322-signed-message";
/// Longest witness stack, in bytes, that [`decode_witness`] accepts (a sanity bound; real stacks
/// are about 110 bytes).
#[cfg(test)]
const MAX_SIGNATURE_BYTES: usize = 4096;

/// The script types the orderbook login handles.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    P2pkh,
    P2sh,
    P2wpkh,
    P2tr,
    Other,
}

pub fn classify(spk: &Script) -> Kind {
    if spk.is_p2pkh() {
        Kind::P2pkh
    } else if spk.is_p2sh() {
        Kind::P2sh
    } else if spk.is_p2wpkh() {
        Kind::P2wpkh
    } else if spk.is_p2tr() {
        Kind::P2tr
    } else {
        Kind::Other
    }
}

/// `sha256(sha256(tag) || sha256(tag) || message)`.
pub fn message_hash(message: &[u8]) -> [u8; 32] {
    let tag = sha256::Hash::hash(TAG);
    let mut e = sha256::Hash::engine();
    e.input(tag.as_byte_array());
    e.input(tag.as_byte_array());
    e.input(message);
    sha256::Hash::from_engine(e).to_byte_array()
}

/// The virtual transaction whose only output is the address's script.
pub fn to_spend(spk: &Script, message: &[u8]) -> Transaction {
    let script_sig = Builder::new()
        .push_int(0)
        .push_slice(message_hash(message))
        .into_script();
    Transaction {
        version: Version(0),
        lock_time: LockTime::ZERO,
        input: vec![TxIn {
            previous_output: OutPoint::new(Txid::all_zeros(), 0xFFFF_FFFF),
            script_sig,
            sequence: Sequence::ZERO,
            witness: Witness::new(),
        }],
        output: vec![TxOut {
            value: Amount::ZERO,
            script_pubkey: spk.to_owned(),
        }],
    }
}

/// The virtual transaction that spends `to_spend`'s output; its input carries the signature.
pub fn to_sign(to_spend: &Transaction) -> Transaction {
    Transaction {
        version: Version(0),
        lock_time: LockTime::ZERO,
        input: vec![TxIn {
            previous_output: OutPoint::new(to_spend.compute_txid(), 0),
            script_sig: ScriptBuf::new(),
            sequence: Sequence::ZERO,
            witness: Witness::new(),
        }],
        output: vec![TxOut {
            value: Amount::ZERO,
            script_pubkey: Builder::new().push_opcode(OP_RETURN).into_script(),
        }],
    }
}

/// The P2WPKH program that a single-key P2WPKH or P2SH-P2WPKH address commits to.
fn wpkh_program(pubkey: &CompressedPublicKey) -> ScriptBuf {
    ScriptBuf::new_p2wpkh(&pubkey.wpubkey_hash())
}

/// The script whose BIP-143 digest the key signs for `spk`: the address's own script for P2WPKH,
/// the redeem script (a P2WPKH program) for P2SH-P2WPKH. `None` when `pubkey` does not belong to
/// the address.
fn wpkh_signing_script(spk: &Script, pubkey: &CompressedPublicKey) -> Option<ScriptBuf> {
    let program = wpkh_program(pubkey);
    match classify(spk) {
        Kind::P2wpkh if spk == program.as_script() => Some(program),
        Kind::P2sh if spk == ScriptBuf::new_p2sh(&program.script_hash()).as_script() => {
            Some(program)
        }
        _ => None,
    }
}

fn sighash_message(to_sign: &Transaction, script: &Script) -> R<Message> {
    let digest = SighashCache::new(to_sign)
        .p2wpkh_signature_hash(0, script, Amount::ZERO, EcdsaSighashType::All)
        .map_err(|e| format!("sighash: {e}"))?;
    Ok(Message::from_digest(digest.to_byte_array()))
}

/// BIP-322 simple signature for a P2WPKH or P2SH-P2WPKH address whose key the caller holds.
/// `sign` receives the BIP-143 digest and returns the ECDSA signature (low-S, as libsecp256k1
/// produces it); the result is the base64 witness stack.
pub fn sign_simple_wpkh(
    spk: &Script,
    message: &[u8],
    pubkey: &CompressedPublicKey,
    sign: impl FnOnce(&Message) -> ecdsa::Signature,
) -> R<String> {
    let script = wpkh_signing_script(spk, pubkey)
        .ok_or("the key does not belong to a P2WPKH or P2SH-P2WPKH address")?;
    let spend = to_spend(spk, message);
    let tx = to_sign(&spend);
    let msg = sighash_message(&tx, &script)?;
    let sig = bitcoin::ecdsa::Signature {
        signature: sign(&msg),
        sighash_type: EcdsaSighashType::All,
    };
    let witness = Witness::from_slice(&[sig.serialize().to_vec(), pubkey.to_bytes().to_vec()]);
    Ok(b64_encode(&serialize(&witness)))
}

/// What the node wallet needs to sign the challenge as one of its own addresses.
#[derive(Debug, Clone, Default)]
pub struct NodeHints {
    /// The address's public key with its BIP-32 origin (`hdmasterfingerprint`, `hdkeypath` of
    /// `getaddressinfo`), so that a descriptor wallet finds the key.
    pub origin: Option<(bitcoin::secp256k1::PublicKey, Fingerprint, DerivationPath)>,
    /// The redeem script of a P2SH-wrapped address.
    pub redeem_script: Option<ScriptBuf>,
}

/// The PSBT of `to_sign` for the node wallet: `witness_utxo` is `to_spend`'s output, the input
/// carries the BIP-32 origin and (for P2SH) the redeem script when known.
pub fn challenge_psbt(spk: &Script, message: &[u8], hints: &NodeHints) -> R<Psbt> {
    let tx = to_sign(&to_spend(spk, message));
    let mut psbt = Psbt::from_unsigned_tx(tx).map_err(|e| format!("psbt: {e}"))?;
    let input = &mut psbt.inputs[0];
    input.witness_utxo = Some(TxOut {
        value: Amount::ZERO,
        script_pubkey: spk.to_owned(),
    });
    if classify(spk) != Kind::P2tr {
        input.sighash_type = Some(EcdsaSighashType::All.into());
    }
    if let Some((pk, fp, path)) = &hints.origin {
        input.bip32_derivation.insert(*pk, (*fp, path.clone()));
    }
    if classify(spk) == Kind::P2sh {
        input.redeem_script = hints.redeem_script.clone();
    }
    Ok(psbt)
}

/// The simple signature out of a PSBT the node wallet signed and finalized: the base64 witness
/// stack of input 0.
pub fn witness_of_signed_psbt(psbt: &Psbt) -> R<String> {
    let input = psbt.inputs.first().ok_or("the signed PSBT has no input")?;
    let witness = input
        .final_script_witness
        .as_ref()
        .filter(|w| !w.is_empty())
        .ok_or("the node wallet did not sign the challenge (is the wallet unlocked?)")?;
    Ok(b64_encode(&serialize(witness)))
}

/// Serialized bytes of a base64 simple signature, as a witness stack.
#[cfg(test)]
pub fn decode_witness(signature_b64: &str) -> R<Witness> {
    let raw = b64_decode(signature_b64)?;
    if raw.is_empty() || raw.len() > MAX_SIGNATURE_BYTES {
        return Err("signature has an unusable size".into());
    }
    bitcoin::consensus::deserialize::<Witness>(&raw)
        .map_err(|_| "signature is not a witness stack".to_string())
}

/// The check a server makes of a simple signature, with BIP-322's semantics: rebuild
/// `to_spend`/`to_sign` from the address script and the message, then run the signature against
/// the BIP-143 (P2WPKH, P2SH-P2WPKH) or BIP-341 (P2TR key path) digest of `to_sign` with
/// `SIGHASH_ALL` (or the taproot default). Used by the tests as the stand-in for the server.
#[cfg(test)]
pub fn verify_simple(spk: &Script, message: &[u8], signature_b64: &str) -> R<()> {
    use bitcoin::secp256k1::{Secp256k1, XOnlyPublicKey};
    use bitcoin::sighash::{Prevouts, TapSighashType};
    let witness = decode_witness(signature_b64)?;
    let items: Vec<&[u8]> = witness.iter().collect();
    let spend = to_spend(spk, message);
    let tx = to_sign(&spend);
    let secp = Secp256k1::verification_only();
    match classify(spk) {
        Kind::P2wpkh | Kind::P2sh => {
            let [sig, pk] = items[..] else {
                return Err("witness must be [signature, public key]".into());
            };
            let pubkey = CompressedPublicKey::from_slice(pk).map_err(|_| "bad public key")?;
            let script =
                wpkh_signing_script(spk, &pubkey).ok_or("public key does not match the address")?;
            let sig = bitcoin::ecdsa::Signature::from_slice(sig).map_err(|_| "bad signature")?;
            if sig.sighash_type != EcdsaSighashType::All {
                return Err("sighash type must be ALL".into());
            }
            let msg = sighash_message(&tx, &script)?;
            secp.verify_ecdsa(&msg, &sig.signature, &pubkey.0)
                .map_err(|_| "signature does not verify".to_string())
        }
        Kind::P2tr => {
            let [sig] = items[..] else {
                return Err("witness must be [signature]".into());
            };
            let sig = bitcoin::taproot::Signature::from_slice(sig).map_err(|_| "bad signature")?;
            if !matches!(
                sig.sighash_type,
                TapSighashType::Default | TapSighashType::All
            ) {
                return Err("sighash type must be DEFAULT or ALL".into());
            }
            let key = XOnlyPublicKey::from_slice(&spk.as_bytes()[2..]).map_err(|_| "bad key")?;
            let prevouts = [spend.output[0].clone()];
            let digest = SighashCache::new(&tx)
                .taproot_key_spend_signature_hash(0, &Prevouts::All(&prevouts), sig.sighash_type)
                .map_err(|e| format!("sighash: {e}"))?;
            secp.verify_schnorr(
                &sig.signature,
                &Message::from_digest(digest.to_byte_array()),
                &key,
            )
            .map_err(|_| "signature does not verify".to_string())
        }
        _ => Err("only P2WPKH, P2SH-P2WPKH and P2TR have simple signatures".into()),
    }
}

/// The hash160 of a compressed key, for tests that compare a witness key to an address.
#[cfg(test)]
pub fn key_hash(pubkey: &CompressedPublicKey) -> [u8; 20] {
    bitcoin::hashes::hash160::Hash::hash(&pubkey.to_bytes()).to_byte_array()
}

// ------------------------------------------------------------------ base64 (standard alphabet)

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn b64_encode(b: &[u8]) -> String {
    let mut s = String::with_capacity(b.len().div_ceil(3) * 4);
    for c in b.chunks(3) {
        let n = (c[0] as u32) << 16
            | (*c.get(1).unwrap_or(&0) as u32) << 8
            | *c.get(2).unwrap_or(&0) as u32;
        s.push(B64[(n >> 18) as usize & 63] as char);
        s.push(B64[(n >> 12) as usize & 63] as char);
        s.push(if c.len() > 1 {
            B64[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        s.push(if c.len() > 2 {
            B64[n as usize & 63] as char
        } else {
            '='
        });
    }
    s
}

/// Padding required, no whitespace.
pub fn b64_decode(s: &str) -> R<Vec<u8>> {
    const BAD: &str = "invalid base64";
    let b = s.as_bytes();
    if b.is_empty() || !b.len().is_multiple_of(4) || b.len() > 8192 {
        return Err(BAD.into());
    }
    let val = |c: u8| B64.iter().position(|x| *x == c).map(|p| p as u32);
    let mut out = Vec::with_capacity(b.len() / 4 * 3);
    let last = b.len() / 4 - 1;
    for (i, c) in b.chunks(4).enumerate() {
        let pad = c.iter().rev().take_while(|x| **x == b'=').count();
        if pad > 2 || (pad > 0 && i != last) {
            return Err(BAD.into());
        }
        let mut n = 0u32;
        for (j, ch) in c.iter().enumerate() {
            let v = if j >= 4 - pad {
                0
            } else {
                val(*ch).ok_or(BAD)?
            };
            n = n << 6 | v;
        }
        out.push((n >> 16) as u8);
        if pad < 2 {
            out.push((n >> 8) as u8);
        }
        if pad < 1 {
            out.push(n as u8);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use bitcoin::hex::DisplayHex;
    use bitcoin::secp256k1::{Secp256k1, SecretKey};
    use bitcoin::PrivateKey;
    use std::str::FromStr;

    /// The key of the BIP-322 test vectors.
    const WIF: &str = "L3VFeEujGtevx9w18HD1fhRbCH67Az2dpCymeRE1SoPK6XQtaN2k";
    const ADDRESS: &str = "bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l";

    fn key() -> (SecretKey, CompressedPublicKey) {
        let sk = PrivateKey::from_wif(WIF).unwrap().inner;
        let pk = CompressedPublicKey(sk.public_key(&Secp256k1::new()));
        (sk, pk)
    }

    fn spk() -> ScriptBuf {
        bitcoin::Address::from_str(ADDRESS)
            .unwrap()
            .assume_checked()
            .script_pubkey()
    }

    /// The spec's signatures were made by Bitcoin Core, which grinds for a low R value (71 bytes
    /// with the sighash type); the grinding is the only difference from the plain RFC 6979 nonce.
    fn sign_with(sk: &SecretKey, spk: &Script, pk: &CompressedPublicKey, msg: &str) -> String {
        let secp = Secp256k1::new();
        sign_simple_wpkh(spk, msg.as_bytes(), pk, |m| secp.sign_ecdsa_low_r(m, sk)).unwrap()
    }

    #[test]
    fn spec_message_hashes() {
        assert_eq!(
            message_hash(b"").to_lower_hex_string(),
            "c90c269c4f8fcbe6880f72a721ddfbf1914268a794cbb21cfafee13770ae19f1"
        );
        assert_eq!(
            message_hash(b"Hello World").to_lower_hex_string(),
            "f0eb03b1a75ac6d9847f55c624a99169b5dccba2a31f5b23bea77ba270de0a7a"
        );
    }

    #[test]
    fn spec_virtual_transaction_ids() {
        let spk = spk();
        for (msg, spend, sign) in [
            (
                "",
                "c5680aa69bb8d860bf82d4e9cd3504b55dde018de765a91bb566283c545a99a7",
                "1e9654e951a5ba44c8604c4de6c67fd78a27e81dcadcfe1edf638ba3aaebaed6",
            ),
            (
                "Hello World",
                "b79d196740ad5217771c1098fc4a4b51e0535c32236c71f1ea4d61a2d603352b",
                "88737ae86f2077145f93cc4b153ae9a1cb8d56afa511988c149c5c8c9d93bddf",
            ),
        ] {
            let ts = to_spend(&spk, msg.as_bytes());
            assert_eq!(ts.compute_txid().to_string(), spend, "to_spend {msg:?}");
            assert_eq!(
                to_sign(&ts).compute_txid().to_string(),
                sign,
                "to_sign {msg:?}"
            );
        }
    }

    #[test]
    fn spec_simple_signatures_are_reproduced_and_verify() {
        let (sk, pk) = key();
        let spk = spk();
        assert_eq!(
            spk,
            ScriptBuf::new_p2wpkh(&pk.wpubkey_hash()),
            "the vector's address is this key's P2WPKH"
        );
        for (msg, sig) in [
            (
                "",
                "AkcwRAIgM2gBAQqvZX15ZiysmKmQpDrG83avLIT492QBzLnQIxYCIBaTpOaD20qRlEylyxFSeEA2ba9YOixpX8z46TSDtS40ASECx/EgAxlkQpQ9hYjgGu6EBCPMVPwVIVJqO4XCsMvViHI=",
            ),
            (
                "Hello World",
                "AkcwRAIgZRfIY3p7/DoVTty6YZbWS71bc5Vct9p9Fia83eRmw2QCICK/ENGfwLtptFluMGs2KsqoNSk89pO7F29zJLUx9a/sASECx/EgAxlkQpQ9hYjgGu6EBCPMVPwVIVJqO4XCsMvViHI=",
            ),
        ] {
            // The published signature verifies, and signing here produces the same bytes.
            verify_simple(&spk, msg.as_bytes(), sig).unwrap();
            assert_eq!(sign_with(&sk, &spk, &pk, msg), sig, "message {msg:?}");
            // It does not verify for another message or another address.
            assert!(verify_simple(&spk, b"Hello Worlds", sig).is_err());
        }
        let other_sk = SecretKey::from_slice(&[7u8; 32]).unwrap();
        let other_pk = CompressedPublicKey(other_sk.public_key(&Secp256k1::new()));
        let other = ScriptBuf::new_p2wpkh(&other_pk.wpubkey_hash());
        assert!(verify_simple(&other, b"", &sign_with(&sk, &spk, &pk, "")).is_err());
    }

    #[test]
    fn p2sh_p2wpkh_signs_with_the_redeem_script_digest_and_verifies() {
        let (sk, pk) = key();
        let redeem = ScriptBuf::new_p2wpkh(&pk.wpubkey_hash());
        let spk = ScriptBuf::new_p2sh(&redeem.script_hash());
        let sig = sign_with(
            &sk,
            &spk,
            &pk,
            "TradeLayer session authentication\nnonce=ab",
        );
        verify_simple(&spk, b"TradeLayer session authentication\nnonce=ab", &sig).unwrap();
        assert!(verify_simple(&spk, b"other", &sig).is_err());
        // The witness is the same shape as P2WPKH, with the same key.
        let w = decode_witness(&sig).unwrap();
        let items: Vec<&[u8]> = w.iter().collect();
        assert_eq!(items.len(), 2);
        assert_eq!(items[1], pk.to_bytes());
        assert_eq!(
            bitcoin::hashes::hash160::Hash::hash(items[1]).to_byte_array(),
            key_hash(&pk)
        );
    }

    #[test]
    fn a_foreign_key_or_script_is_refused_before_signing() {
        let (sk, pk) = key();
        let secp = Secp256k1::new();
        let p2pkh = ScriptBuf::new_p2pkh(&pk.pubkey_hash());
        assert!(sign_simple_wpkh(&p2pkh, b"m", &pk, |m| secp.sign_ecdsa(m, &sk)).is_err());
        let other = SecretKey::from_slice(&[9u8; 32]).unwrap();
        let other_pk = CompressedPublicKey(other.public_key(&secp));
        assert!(sign_simple_wpkh(&spk(), b"m", &other_pk, |m| secp.sign_ecdsa(m, &other)).is_err());
    }

    #[test]
    fn verification_rejects_malformed_signatures() {
        let (sk, pk) = key();
        let spk = spk();
        let good = sign_with(&sk, &spk, &pk, "m");
        for bad in ["", "AA==", "not base64!", "AAAA", &good[..good.len() - 4]] {
            assert!(verify_simple(&spk, b"m", bad).is_err(), "{bad:?}");
        }
        // A flipped bit in the signature does not verify.
        let mut raw = b64_decode(&good).unwrap();
        raw[10] ^= 1;
        assert!(verify_simple(&spk, b"m", &b64_encode(&raw)).is_err());
        // Another sighash type is refused.
        let mut raw = b64_decode(&good).unwrap();
        let sig_len = raw[1] as usize;
        raw[1 + sig_len] = 0x02;
        assert!(verify_simple(&spk, b"m", &b64_encode(&raw)).is_err());
        // A P2PKH or P2WSH address has no simple signature here.
        assert!(verify_simple(&ScriptBuf::new_p2pkh(&pk.pubkey_hash()), b"m", &good).is_err());
    }

    #[test]
    fn the_challenge_psbt_carries_the_output_and_hints() {
        let (_, pk) = key();
        let spk = spk();
        let psbt = challenge_psbt(&spk, b"m", &NodeHints::default()).unwrap();
        assert_eq!(psbt.unsigned_tx, to_sign(&to_spend(&spk, b"m")));
        let i = &psbt.inputs[0];
        assert_eq!(
            i.witness_utxo,
            Some(TxOut {
                value: Amount::ZERO,
                script_pubkey: spk.clone()
            })
        );
        assert_eq!(i.sighash_type, Some(EcdsaSighashType::All.into()));
        assert!(i.bip32_derivation.is_empty());
        let fp = Fingerprint::from([1, 2, 3, 4]);
        let path = DerivationPath::from_str("m/84'/1'/0'/0/5").unwrap();
        let hints = NodeHints {
            origin: Some((pk.0, fp, path.clone())),
            redeem_script: Some(ScriptBuf::new_p2wpkh(&pk.wpubkey_hash())),
        };
        // The redeem script only goes into a P2SH input.
        let with = challenge_psbt(&spk, b"m", &hints).unwrap();
        assert_eq!(with.inputs[0].bip32_derivation[&pk.0], (fp, path));
        assert!(with.inputs[0].redeem_script.is_none());
        let p2sh = ScriptBuf::new_p2sh(&hints.redeem_script.as_ref().unwrap().script_hash());
        let with = challenge_psbt(&p2sh, b"m", &hints).unwrap();
        assert_eq!(with.inputs[0].redeem_script, hints.redeem_script);
        // An unsigned PSBT has no witness to extract.
        assert!(witness_of_signed_psbt(&psbt).is_err());
    }

    #[test]
    fn base64_round_trips_and_rejects_garbage() {
        for (raw, b64) in [
            (&b"f"[..], "Zg=="),
            (b"fo", "Zm8="),
            (b"foo", "Zm9v"),
            (&[0xfb, 0xff, 0xfe][..], "+//+"),
        ] {
            assert_eq!(b64_encode(raw), b64);
            assert_eq!(b64_decode(b64).unwrap(), raw);
        }
        for bad in ["", "Zg=", "Zg", "Z===", "Zg==Zg==", "Zm9v!A==", "Zm 9v"] {
            assert!(b64_decode(bad).is_err(), "{bad:?}");
        }
    }
}
