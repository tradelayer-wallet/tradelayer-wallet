# tl-desktop-core

The testable core of the Rust/Tauri replacement for the Electron/Node TradeLayer desktop wallet. The
Tauri shell (`rust/tl-desktop`) wires its commands to this crate; the crate itself has no UI, no
network and no clock of its own. The node, the clock and the entropy source are traits, the vault
comes from [`tl-wallet-core`](https://github.com/tradelayer-wallet/TL-Extension) (pinned git
revision), and every rule below is covered by a test and, for the session rules, a Lean proof.

* Baseline: `tradelayer-wallet` master `7ddba36ca06538510e6460df0ddece8a71fcb547`, branch `feat/rust-port`.
* `tl-wallet-core` pinned at `0f296d6310e4e4eb4d4de08744d72eee0cb934c0` (`Cargo.toml`, `Cargo.lock`).
* Toolchain Rust 1.90.0, Lean 4 `v4.34.1`. Licence ISC.

## API

```rust
pub trait NodeRpc {
    fn chain(&mut self) -> Result<String, NodeError>;
    fn scan(&mut self, descriptors: &[String]) -> Result<ScanResult, NodeError>;
    fn fee_rate_sat_per_vb(&mut self, conf_target: u16) -> Result<Option<u64>, NodeError>;
    fn broadcast(&mut self, raw_tx_hex: &str) -> Result<String, NodeError>;
}
pub trait Clock   { fn now_ms(&self) -> u64; }
pub trait Entropy { fn fill(&mut self, buf: &mut [u8]) -> Result<(), CoreError>; }

pub struct Wallet<N: NodeRpc, S: VaultStore, C: Clock, E: Entropy> { .. }
impl Wallet {
    pub fn new(cfg: Config, node: N, store: S, clock: C, entropy: E) -> Self;
    pub fn status(&mut self) -> Status;       // network_id, has_vault, unlocked, node_chain, chain_matches
    pub fn create(&mut self, password: &str) -> Result<String, CoreError>;   // 12-word phrase, once
    pub fn import(&mut self, phrase: &str, password: &str) -> Result<(), CoreError>;
    pub fn unlock(&mut self, password: &str) -> Result<(), CoreError>;
    pub fn lock(&mut self);
    pub fn receive_address(&self) -> Result<String, CoreError>;
    pub fn balance(&mut self) -> Result<Balance, CoreError>;
    pub fn prepare_send(&mut self, to: &str, amount_sats: u64, fee_rate: Option<u64>)
        -> Result<SendPreview, CoreError>;
    pub fn confirm_send(&mut self, plan_id: &str) -> Result<SendResult, CoreError>;
    pub fn cancel_send(&mut self, plan_id: &str) -> bool;
    // additions: tick() purges expired plans, pending_plans(), config(), network()
}
```

`S` is `tl_wallet_core::vault::VaultStore` (string key/value with compare-and-swap). `FileStore`
(one directory, atomic writes) is the production implementation, `InMemoryStore` (re-export of
`tl-wallet-core`'s `MemoryStore`) serves tests. `Config::new(network)` carries the bounds:
`max_fee_rate_sat_vb` 1000, `max_fee_sats` 1 000 000, `default_fee_rate_sat_vb` 2 (regtest only),
`plan_ttl_ms` 120 000, `capability_ttl_ms` 30 000, KDF `Kdf::DEFAULT` (scrypt 2^15).

The signing capability is granted to the origin `http://tauri.localhost` (`DESKTOP_ORIGIN`), the
origin Tauri 2 serves the webview from on Windows. `Origin::from_url` of `tl-wallet-core` accepts
only http(s), so the `tauri://localhost` app scheme cannot be used. The origin is a label inside
the capability, not an access check by itself: `confirm_send` must be called only from the trusted
UI's confirm button, because calling it is the user-approval act.

## Rules and the legacy defects they replace

Legacy references are to the Electron wallet (`packages/wallet-server`), as recorded in
`rust/tl-wallet-service/README.md`.

| Rule here | Legacy defect | Test |
|---|---|---|
| No server, no proxy: the shell calls `Wallet` methods, and the node sees only `chain`, `scan`, `fee_rate_sat_per_vb`, `broadcast` | unauthenticated localhost fastify server (`fastify-server.ts:33`, every route); `rpc-call` forwards any method such as `dumpprivkey` (`main.route.ts:13`) | the `NodeRpc` trait has four methods; `tests/wallet.rs` scripted node |
| Network is explicit in `Config`; the node chain must equal it before every scan, signing and broadcast (`WrongChain`); never inferred from an address | n/a (new rule); the extension wallet defaulted unknown networks to LTC (`tl-wallet-core` README, `walletUtils.js`) | `chain_mismatch_blocks_scan_prepare_and_balance`, `chain_flip_between_prepare_and_confirm_...`, `status_reports_chain_match_for_every_network`, `the_network_is_never_inferred_from_the_address` |
| Scan descriptors are the account's own `addr(receive)` and `addr(change)`; a UTXO whose script is not the account's rejects the whole scan | n/a (new rule) | `a_foreign_script_rejects_the_whole_scan`, `malformed_scan_entries_are_typed_errors`, `scan_asks_for_the_receive_and_change_addresses` |
| Amounts, fee and change come from the wallet's own scan and the exact plan; signing re-derives inputs, outputs and fee from the PSBT and checks them against the one-use capability | signing trusts caller input amounts and any fee (`crypto.util.ts:86-129`, `main.route.ts:91-110`) | `prepare_then_confirm_broadcasts_exactly_the_previewed_transaction` (decodes the raw tx: outputs equal the preview, inputs = outputs + fee) |
| Two steps: `prepare_send` only builds and remembers a plan; `confirm_send` is the only path that signs. Plans are single-use, bounded (8), expire after 120 s, and die with `lock` | the signing route took the caller's inputs and fee in one call (`main.route.ts:91-110`) | `confirm_twice_broadcasts_once`, `the_plan_table_is_bounded_at_eight`, `an_expired_plan_is_refused_and_consumed`, `lock_clears_every_pending_plan`, `locked_wallet_refuses_everything_without_touching_the_node` |
| The plan is removed before the chain check, signing and broadcast, so a failed broadcast is never retried under the same id | n/a (no retry control) | `a_failed_broadcast_consumes_the_plan_and_surfaces_the_node_error`, `chain_flip_between_...` |
| Fee rate: explicit or node estimate (target 6) or the regtest default; zero and above-max rejected; absolute fee bound; per-vbyte policy with conservative sizes (85 vB fixed + 68 vB per input) | fee was a fixed per-input constant, not bound to what the user approved (`tx-builder.service.ts:208-224`) | `explicit_fee_rate_is_bounded`, `absolute_fee_bound_applies`, `fee_rate_defaults_to_the_node_estimate_with_target_six`, `a_node_estimate_above_the_bound_is_refused`, `a_public_network_without_an_estimate_needs_an_explicit_rate` |
| Pending plans reserve their inputs and broadcast inputs stay hidden until the scan drops them, so two plans never spend the same output | n/a (new) | `pending_plans_reserve_their_inputs`, `broadcast_inputs_stay_hidden_until_the_node_drops_them` |
| The mnemonic exists in memory only inside `create` (zeroized buffers) and the returned string; at rest only the sealed vault (scrypt + XChaCha20-Poly1305). Wrong password and a tampered blob are the same typed error. `create`/`import` never overwrite a vault. | n/a (not part of the legacy surface reviewed for this crate) | `lock_unlock_and_wrong_password`, `create_and_import_never_overwrite_a_vault`, `only_vault_files_are_written_and_the_phrase_is_not_among_them`, `a_tampered_vault_file_is_a_wrong_password_not_garbage` |
| `FileStore` writes through a temp file in the same directory, `fsync`, then `rename` (replaces on Windows); keys are percent-encoded into file names; reads are size-bounded | n/a | `store::tests::*` (9), `the_vault_survives_a_restart` |
| u64 sats with checked arithmetic, per-entry scan amounts capped at 84 000 000 coins, at most 2000 UTXOs, no panics, `#![forbid(unsafe_code)]` | n/a (new rule) | `balance_sums_the_largest_amounts_exactly`, `insufficient_funds_and_dust_are_typed` |

## Dependencies

| Crate | Why |
|---|---|
| `tl-wallet-core` (git, pinned `rev`) | accounts, address parsing, coin selection, PSBT build and signing, the signing capability, the vault format and manager |
| `bitcoin 0.32` (`std`, `secp-recovery`, the same features `tl-wallet-core` selects) | txid and script hex parsing of scan results, `OutPoint`; tests decode the broadcast transaction with it. `tl-wallet-core` does not re-export it |
| `zeroize 1` (`alloc`, already pulled in by `tl-wallet-core`) | wipes the entropy buffer and the mnemonic string held inside `create` |

No `serde`: results are plain structs with public fields and the shell maps them to its own wire
types. No `tl-rpc-client`: the node sits behind `NodeRpc`. `Cargo.lock` is committed; the
`[profile.dev.package.*]` entries only speed up scrypt in tests.

## Commands

```
TOOLS=/mnt/c/Users/patri/Documents/Codex/2026-10-30/new-chat/work/tools
C=C:/Users/patri/Documents/Codex/2026-10-30/new-chat/work/repos/tradelayer-wallet/rust/tl-desktop-core
MSYS_NO_PATHCONV=1 wsl.exe -d Ubuntu-24.04 -- bash $TOOLS/rust.sh $C fetch --locked            # needs network once (git dependency)
MSYS_NO_PATHCONV=1 wsl.exe -d Ubuntu-24.04 -- bash $TOOLS/rust.sh $C test --locked --offline
MSYS_NO_PATHCONV=1 wsl.exe -d Ubuntu-24.04 -- bash $TOOLS/rust.sh $C clippy --locked --offline --all-targets -- -D warnings
MSYS_NO_PATHCONV=1 wsl.exe -d Ubuntu-24.04 -- bash $TOOLS/rust.sh $C fmt --all -- --check
MSYS_NO_PATHCONV=1 wsl.exe -d Ubuntu-24.04 -- bash $TOOLS/lean.sh $C/lean                      # prints LEAN_CHECK_OK
```

`.github/workflows/rust-tl-desktop-core.yml` runs the same checks plus the Lean job; it runs once
the branch is pushed.

## Lean (`lean/TlDesktopCore/Session.lean`)

`step` models `Wallet` (`unlock` stands for create/import/unlock, `prepare` for `prepare_send`,
`confirm` for `confirm_send`, and so on) over a state of `locked | unlocked (plan table)`, a next-id
counter and the broadcast log. `PlanTable` is `src/session.rs`; `doPrepare` and `doConfirm` follow
the branch structure of `prepare_send` and `confirm_send` (purge, then full check, then insert;
remove first, then broadcast only if live and the chain check passed).

| Theorem | Statement |
|---|---|
| `reach_inv` | an invariant holds in every reachable state: ids unique and fresh, table <= 8, log without repeats |
| `table_bounded` | the table never holds more than 8 plans |
| `broadcast_at_most_once` | the broadcast log never repeats an id, over every operation sequence |
| `table_ids_unique` | plan ids in the table are pairwise distinct |
| `confirm_requires` | a confirm that broadcasts implies: unlocked, plan in the table, `now < expires`, chain check passed |
| `confirm_succeeds` | the converse: unlocked, plan found, unexpired, chain ok implies the id is appended to the log |
| `confirm_consumes` | after any confirm, the id is not in the table (including the expired and chain-mismatch outcomes) |
| `confirm_twice_one_broadcast` | a second confirm of the same id never changes the log |
| `locked_confirm_noop` | confirm on a locked wallet changes nothing |
| `chain_mismatch_no_broadcast` | a failed chain check never broadcasts |
| `prepare_chain_mismatch_noop` | a failed chain check in `prepare` changes nothing |
| `expired_no_broadcast` | an expired plan is never broadcast |
| `lock_empties` | no plan survives `lock`; the next unlock starts from `[]` |
| `prepare_full_rejects` | with 8 live plans `prepare` adds nothing and draws no id (only the purge applies) |
| `prepare_keeps_log` | prepare never touches the broadcast log |

`example ... := by decide` vectors in the same file (`decide` only): confirm once, expiry at 119 999
ms versus 120 000 ms, expired confirm consumes the plan, ninth plan refused, expired plans make
room, cancel frees a slot, lock then confirm, chain mismatch at confirm and at prepare, two plans
confirmed independently. Rust mirrors: `session::tests::vec_*` (`PlanTable` directly) and, at the
`Wallet` level, `confirm_twice_broadcasts_once`, `an_expired_plan_is_refused_and_consumed`,
`a_plan_one_millisecond_before_expiry_is_confirmable`, `the_plan_table_is_bounded_at_eight`,
`expired_plans_do_not_hold_the_table_full`, `lock_clears_every_pending_plan`,
`chain_flip_between_prepare_and_confirm_...`, `chain_mismatch_blocks_scan_prepare_and_balance`.

Where the model abstracts: keys, amounts, signing and the node reply are not modelled (the
capability predicates are proved in `tl-wallet-core`); `next` stands for a fresh 128-bit id, which
the Rust code draws from `Entropy` and checks only against live plans; time is a `Nat` argument.
`AxiomCheck.lean` prints the axioms of every theorem (`propext`, `Quot.sound`, `Classical.choice`
only; no `sorryAx`).

## Gaps

* No password-attempt throttling beyond the scrypt cost; the shell can add a delay or lockout.
* `FileStore` assumes one process per directory (single-instance shell); there is no lock file.
* `scantxoutset` does not see the mempool, so `unconfirmed_sats` is always 0 and change from a
  broadcast spend is not spendable until mined. Coinbase outputs with fewer than 100
  confirmations (the scan's `coinbase` flag) are reported as `immature_sats` and never selected
  (`tests/wallet.rs::immature_coinbase_is_reported_but_never_spendable`).
* Dogecoin networks return `UnsupportedNetwork` (the scan has no previous transactions, which
  legacy p2pkh signing needs). Only the single P2WPKH account of `tl-wallet-core` exists: no
  multisig, no OP_RETURN payload sends, no TradeLayer protocol transactions.
* Fee sizes are fixed estimates (85 vB + 68 vB per input), conservative for P2WPKH inputs.
* The node adapter, the system clock, OS entropy and the Tauri commands are written elsewhere;
  nothing here has run against a real node or in the shell. All tests use a scripted node.
* The vault is bound to one network (the sealed header records it): each network needs its own
  store directory.
* `Entropy` failure inside the vault surfaces as `Vault(Random)`.
