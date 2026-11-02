/-!
# Session state machine (models `src/session.rs` and the control flow of `src/wallet.rs`)

The wallet is `locked` or `unlocked` with a table of pending send plans. Operations:

* `unlock`   models `create`, `import` and `unlock` (all end in `unlocked []` from `locked`; on an
             unlocked wallet they leave the state alone: `create`/`import` fail with `VaultExists`,
             `unlock` only re-verifies the password).
* `lock`     drops the account and clears the table (`Wallet::lock`).
* `prepare`  `Wallet::prepare_send`. `chainOk` is the result of `ensure_chain`; on a mismatch the
             operation fails before the table is touched. Otherwise expired plans are purged and a
             plan is added unless the table is full (the purge persists on the full path).
* `confirm`  `Wallet::confirm_send`. The plan is removed first; it is broadcast only when it was
             live (`now < expires`) and the chain check passed.
* `cancel`   `Wallet::cancel_send`.
* `tick`     `Wallet::tick`.

Abstractions: key material, amounts, signing and the node's reply are not modelled (signing and
the capability are exercised by `tl-wallet-core`'s own proofs; here `broadcast` is the log entry).
`next` stands for the 128-bit plan id drawn from `Entropy`: the model assumes each new id is fresh
(never equal to a live or already broadcast id), which the Rust code only guarantees with
probability 1 - 2^-128 per draw and detects (`Internal("plan id collision")`) among live plans.
-/
namespace TlDesktopCore.Session

/-- `config::MAX_PENDING_PLANS`. -/
def bound : Nat := 8

/-- `Config::plan_ttl_ms` default. -/
def ttl : Nat := 120000

structure Plan where
  id : Nat
  expires : Nat
  deriving DecidableEq, Repr

inductive Sess where
  | locked
  | unlocked (plans : List Plan)
  deriving DecidableEq, Repr

structure State where
  sess : Sess
  next : Nat
  /-- Ids handed to the node, newest first. -/
  log : List Nat
  deriving DecidableEq, Repr

inductive Op where
  | unlock
  | lock
  | prepare (now : Nat) (chainOk : Bool)
  | confirm (id now : Nat) (chainOk : Bool)
  | cancel (id : Nat)
  | tick (now : Nat)

def init : State := { sess := .locked, next := 0, log := [] }

/-- `PlanTable`: an entry is live while `now < expires`. -/
def live (now : Nat) (p : Plan) : Bool := decide (now < p.expires)

/-- `PlanTable::purge_expired`. -/
def purge (now : Nat) (ps : List Plan) : List Plan := ps.filter (live now)

/-- Remove every plan with this id. -/
def dropId (id : Nat) (ps : List Plan) : List Plan := ps.filter (fun q => q.id != id)

def doPrepare (s : State) (ps : List Plan) (now : Nat) : State :=
  if (purge now ps).length < bound then
    { s with sess := .unlocked ({ id := s.next, expires := now + ttl } :: purge now ps),
             next := s.next + 1 }
  else
    { s with sess := .unlocked (purge now ps) }

def doConfirm (s : State) (ps : List Plan) (id now : Nat) (ok : Bool) : State :=
  match ps.find? (fun p => p.id == id) with
  | none => s
  | some p =>
    if live now p && ok then
      { s with sess := .unlocked (dropId id ps), log := id :: s.log }
    else
      { s with sess := .unlocked (dropId id ps) }

def step (s : State) : Op → State
  | .unlock =>
    match s.sess with
    | .locked => { s with sess := .unlocked [] }
    | .unlocked _ => s
  | .lock => { s with sess := .locked }
  | .prepare now ok =>
    match s.sess with
    | .locked => s
    | .unlocked ps => if ok then doPrepare s ps now else s
  | .confirm id now ok =>
    match s.sess with
    | .locked => s
    | .unlocked ps => doConfirm s ps id now ok
  | .cancel id =>
    match s.sess with
    | .locked => s
    | .unlocked ps => { s with sess := .unlocked (dropId id ps) }
  | .tick now =>
    match s.sess with
    | .locked => s
    | .unlocked ps => { s with sess := .unlocked (purge now ps) }

def run (s : State) (ops : List Op) : State := ops.foldl step s

/-- Number of plans in the table (0 when locked). -/
def planCount (s : State) : Nat :=
  match s.sess with
  | .locked => 0
  | .unlocked ps => ps.length

/-! ## Reachable states and the invariant -/

inductive Reach : State → Prop where
  | init : Reach init
  | step {s : State} (op : Op) : Reach s → Reach (step s op)

structure PlansInv (next : Nat) (log : List Nat) (ps : List Plan) : Prop where
  len : ps.length ≤ bound
  uniq : ps.Pairwise (fun a b => a.id ≠ b.id)
  fresh : ∀ p ∈ ps, p.id < next ∧ p.id ∉ log

structure Inv (s : State) : Prop where
  lt : ∀ i ∈ s.log, i < s.next
  nodup : s.log.Nodup
  plans : ∀ ps, s.sess = .unlocked ps → PlansInv s.next s.log ps

theorem plansInv_sub {next log ps ps'} (h : PlansInv next log ps) (sub : ps'.Sublist ps) :
    PlansInv next log ps' :=
  { len := Nat.le_trans sub.length_le h.len
    uniq := h.uniq.sublist sub
    fresh := fun p hp => h.fresh p (sub.subset hp) }

theorem inv_init : Inv init :=
  { lt := by intro i hi; simp [init] at hi
    nodup := by simp [init]
    plans := by intro ps h; simp [init] at h }

theorem plansInv_nil (next : Nat) (log : List Nat) : PlansInv next log [] :=
  { len := by simp [bound]
    uniq := List.Pairwise.nil
    fresh := by intro p hp; simp at hp }

theorem inv_prepare {s : State} {ps : List Plan} (hs : Inv s) (hsess : s.sess = .unlocked ps)
    (now : Nat) : Inv (doPrepare s ps now) := by
  have hp := hs.plans ps hsess
  have hsub : (purge now ps).Sublist ps := List.filter_sublist
  have hp' := plansInv_sub hp hsub
  unfold doPrepare
  split
  · rename_i hlt
    refine ⟨?_, hs.nodup, ?_⟩
    · intro i hi; have := hs.lt i hi; simp only at *; omega
    · intro qs hq
      simp only [Sess.unlocked.injEq] at hq
      subst hq
      refine ⟨?_, ?_, ?_⟩
      · simp only [List.length_cons]; omega
      · refine List.Pairwise.cons ?_ hp'.uniq
        intro q hq
        have := (hp'.fresh q hq).1
        simp only; omega
      · intro q hq
        rcases List.mem_cons.mp hq with h | h
        · subst h
          refine ⟨by simp only; omega, ?_⟩
          intro hmem
          have := hs.lt _ hmem
          simp only at this; omega
        · have := hp'.fresh q h
          exact ⟨by simp only; omega, this.2⟩
  · refine ⟨hs.lt, hs.nodup, ?_⟩
    intro qs hq
    simp only [Sess.unlocked.injEq] at hq
    subst hq
    exact hp'

theorem plansInv_dropId {next log ps} (h : PlansInv next log ps) (id : Nat) :
    PlansInv next log (dropId id ps) :=
  plansInv_sub h List.filter_sublist

theorem inv_confirm {s : State} {ps : List Plan} (hs : Inv s) (hsess : s.sess = .unlocked ps)
    (id now : Nat) (ok : Bool) : Inv (doConfirm s ps id now ok) := by
  have hp := hs.plans ps hsess
  unfold doConfirm
  split
  · exact hs
  · rename_i p hfind
    have hmem : p ∈ ps := List.mem_of_find?_eq_some hfind
    have hid : p.id = id := by
      have := List.find?_some hfind
      simpa using this
    have hpf := hp.fresh p hmem
    split
    · refine ⟨?_, ?_, ?_⟩
      · intro i hi
        rcases List.mem_cons.mp hi with h | h
        · subst h; have := hpf.1; rw [hid] at this; exact this
        · exact hs.lt i h
      · refine List.nodup_cons.mpr ⟨?_, hs.nodup⟩
        have := hpf.2; rw [hid] at this; exact this
      · intro qs hq
        simp only [Sess.unlocked.injEq] at hq
        subst hq
        have hd := plansInv_dropId hp id
        refine ⟨hd.len, hd.uniq, ?_⟩
        intro q hq
        have hqmem : q ∈ ps ∧ q.id != id := by
          simpa [dropId] using hq
        have hqf := hp.fresh q hqmem.1
        refine ⟨hqf.1, ?_⟩
        intro hin
        rcases List.mem_cons.mp hin with h | h
        · simp [h] at hqmem
        · exact hqf.2 h
    · refine ⟨hs.lt, hs.nodup, ?_⟩
      intro qs hq
      simp only [Sess.unlocked.injEq] at hq
      subst hq
      exact plansInv_dropId hp id

theorem inv_step {s : State} (hs : Inv s) (op : Op) : Inv (step s op) := by
  cases op with
  | unlock =>
    cases hsess : s.sess with
    | locked =>
      simp only [step, hsess]
      refine ⟨hs.lt, hs.nodup, ?_⟩
      intro ps h
      simp only [Sess.unlocked.injEq] at h
      subst h
      exact plansInv_nil _ _
    | unlocked ps => simpa [step, hsess] using hs
  | lock =>
    refine ⟨hs.lt, hs.nodup, ?_⟩
    intro ps h
    simp [step] at h
  | prepare now ok =>
    cases hsess : s.sess with
    | locked => simpa [step, hsess] using hs
    | unlocked ps =>
      cases ok with
      | true =>
        simp only [step, hsess, ↓reduceIte]
        exact inv_prepare hs hsess now
      | false => simpa [step, hsess] using hs
  | confirm id now ok =>
    cases hsess : s.sess with
    | locked => simpa [step, hsess] using hs
    | unlocked ps =>
      simp only [step, hsess]
      exact inv_confirm hs hsess id now ok
  | cancel id =>
    cases hsess : s.sess with
    | locked => simpa [step, hsess] using hs
    | unlocked ps =>
      simp only [step, hsess]
      refine ⟨hs.lt, hs.nodup, ?_⟩
      intro qs hq
      simp only [Sess.unlocked.injEq] at hq
      subst hq
      exact plansInv_dropId (hs.plans ps hsess) id
  | tick now =>
    cases hsess : s.sess with
    | locked => simpa [step, hsess] using hs
    | unlocked ps =>
      simp only [step, hsess]
      refine ⟨hs.lt, hs.nodup, ?_⟩
      intro qs hq
      simp only [Sess.unlocked.injEq] at hq
      subst hq
      exact plansInv_sub (hs.plans ps hsess) List.filter_sublist

theorem reach_inv {s : State} (h : Reach s) : Inv s := by
  induction h with
  | init => exact inv_init
  | step op _ ih => exact inv_step ih op

/-! ## Theorems -/

/-- The table never holds more than `bound` plans. -/
theorem table_bounded {s : State} (h : Reach s) : planCount s ≤ bound := by
  have hi := reach_inv h
  unfold planCount
  split
  · simp [bound]
  · rename_i ps hsess
    exact (hi.plans ps hsess).len

/-- A plan id reaches the node at most once: the broadcast log never repeats an id. -/
theorem broadcast_at_most_once {s : State} (h : Reach s) : s.log.Nodup :=
  (reach_inv h).nodup

/-- Plan ids in the table are pairwise distinct. -/
theorem table_ids_unique {s : State} (h : Reach s) {ps : List Plan}
    (hsess : s.sess = .unlocked ps) : ps.Pairwise (fun a b => a.id ≠ b.id) :=
  ((reach_inv h).plans ps hsess).uniq

theorem step_confirm {s : State} {ps : List Plan} (hsess : s.sess = .unlocked ps)
    (id now : Nat) (ok : Bool) : step s (.confirm id now ok) = doConfirm s ps id now ok := by
  simp [step, hsess]

/-- Confirm broadcasts only when the wallet is unlocked, the plan is in the table and unexpired,
and the chain check passed. -/
theorem confirm_requires {s : State} {id now : Nat} {ok : Bool}
    (h : (step s (.confirm id now ok)).log ≠ s.log) :
    ∃ ps p, s.sess = .unlocked ps ∧ p ∈ ps ∧ p.id = id ∧ now < p.expires ∧ ok = true := by
  cases hsess : s.sess with
  | locked => simp [step, hsess] at h
  | unlocked ps =>
    rw [step_confirm hsess] at h
    unfold doConfirm at h
    split at h
    · exact absurd rfl h
    · rename_i p hfind
      by_cases hc : (live now p && ok) = true
      · simp only [live, Bool.and_eq_true, decide_eq_true_eq] at hc
        refine ⟨ps, p, rfl, List.mem_of_find?_eq_some hfind, ?_, hc.1, hc.2⟩
        simpa using List.find?_some hfind
      · simp only [hc] at h
        exact absurd rfl h

/-- Converse: an unlocked wallet with a live plan and a passing chain check broadcasts it. -/
theorem confirm_succeeds {s : State} {ps : List Plan} {p : Plan} {id now : Nat}
    (hsess : s.sess = .unlocked ps) (hfind : ps.find? (fun q => q.id == id) = some p)
    (hlive : now < p.expires) :
    (step s (.confirm id now true)).log = id :: s.log := by
  simp [step, hsess, doConfirm, hfind, live, hlive]

/-- Confirm removes the plan whatever happens, so the id is gone from the table afterwards. -/
theorem confirm_consumes {s : State} {id now : Nat} {ok : Bool} {ps' : List Plan}
    (h : (step s (.confirm id now ok)).sess = .unlocked ps') :
    ∀ q ∈ ps', q.id ≠ id := by
  cases hsess : s.sess with
  | locked => simp [step, hsess] at h
  | unlocked ps =>
    rw [step_confirm hsess] at h
    unfold doConfirm at h
    split at h
    · rename_i hnone
      have h' : ps = ps' := by simpa [hsess] using h
      subst h'
      intro q hq hqid
      have := List.find?_eq_none.mp hnone q hq
      simp [hqid] at this
    · rename_i p hfind
      have h' : dropId id ps = ps' := by
        by_cases hc : (live now p && ok) = true
        · simp only [hc, ↓reduceIte] at h; simpa using h
        · simp only [hc] at h; simpa using h
      subst h'
      intro q hq hqid
      simp [dropId] at hq
      exact hq.2 hqid

/-- A second confirm of the same id never reaches the node. -/
theorem confirm_twice_one_broadcast (s : State) (id n1 n2 : Nat) (o1 o2 : Bool) :
    (step (step s (.confirm id n1 o1)) (.confirm id n2 o2)).log =
      (step s (.confirm id n1 o1)).log := by
  generalize hs1 : step s (.confirm id n1 o1) = s1
  cases hsess : s1.sess with
  | locked => simp [step, hsess]
  | unlocked ps' =>
    have hnone : ps'.find? (fun q => q.id == id) = none := by
      rw [List.find?_eq_none]
      intro q hq
      have := confirm_consumes (s := s) (id := id) (now := n1) (ok := o1) (ps' := ps')
        (by rw [hs1]; exact hsess) q hq
      simpa using this
    simp [step_confirm hsess, doConfirm, hnone]

/-- A locked wallet cannot confirm anything. -/
theorem locked_confirm_noop {s : State} (h : s.sess = .locked) (id now : Nat) (ok : Bool) :
    step s (.confirm id now ok) = s := by
  simp [step, h]

/-- A chain mismatch never broadcasts. -/
theorem chain_mismatch_no_broadcast (s : State) (id now : Nat) :
    (step s (.confirm id now false)).log = s.log := by
  cases hsess : s.sess with
  | locked => simp [step, hsess]
  | unlocked ps =>
    rw [step_confirm hsess]
    unfold doConfirm
    split <;> simp

/-- A chain mismatch in `prepare` leaves the whole state unchanged. -/
theorem prepare_chain_mismatch_noop (s : State) (now : Nat) :
    step s (.prepare now false) = s := by
  cases hsess : s.sess <;> simp [step, hsess]

/-- An expired plan is never broadcast. -/
theorem expired_no_broadcast {s : State} {ps : List Plan} {p : Plan} {id now : Nat} {ok : Bool}
    (hsess : s.sess = .unlocked ps) (hfind : ps.find? (fun q => q.id == id) = some p)
    (hexp : p.expires ≤ now) : (step s (.confirm id now ok)).log = s.log := by
  have : ¬ now < p.expires := Nat.not_lt.mpr hexp
  simp [step, hsess, doConfirm, hfind, live, this]

/-- Lock leaves no plan behind, and the next unlock starts from an empty table. -/
theorem lock_empties (s : State) :
    (∀ ps, (step s .lock).sess ≠ .unlocked ps) ∧
    (step (step s .lock) .unlock).sess = .unlocked [] := by
  constructor
  · intro ps h; simp [step] at h
  · simp [step]

/-- When the table still holds `bound` live plans, `prepare` adds nothing and draws no id; only
the purge of expired plans takes effect. -/
theorem prepare_full_rejects {s : State} {ps : List Plan} (hsess : s.sess = .unlocked ps) (now : Nat)
    (hfull : bound ≤ (purge now ps).length) :
    step s (.prepare now true) = { s with sess := .unlocked (purge now ps) } := by
  have hlt : ¬ (purge now ps).length < bound := Nat.not_lt.mpr hfull
  simp [step, hsess, doPrepare, hlt]

/-- Prepare never changes the broadcast log. -/
theorem prepare_keeps_log (s : State) (now : Nat) (ok : Bool) :
    (step s (.prepare now ok)).log = s.log := by
  cases hsess : s.sess with
  | locked => simp [step, hsess]
  | unlocked ps =>
    cases ok with
    | false => simp [step, hsess]
    | true =>
      simp only [step, hsess, ↓reduceIte]
      unfold doPrepare
      split <;> rfl

/-! ## Decide vectors (mirrored by `session::tests::vec_*` and `tests/wallet.rs`) -/

def prep (now : Nat) : Op := .prepare now true

/-- Prepare at 0, confirm at 1000: broadcast once; a second confirm adds nothing. -/
example : (run init [.unlock, prep 0, .confirm 0 1000 true, .confirm 0 1000 true]).log = [0] := by
  decide

/-- Expiry is exclusive: confirmed at `ttl - 1`, refused at `ttl`. -/
example : (run init [.unlock, prep 0, .confirm 0 119999 true]).log = [0] := by decide
example : (run init [.unlock, prep 0, .confirm 0 120000 true]).log = [] := by decide

/-- An expired confirm still consumes the plan. -/
example : planCount (run init [.unlock, prep 0, .confirm 0 120000 true]) = 0 := by decide

/-- The ninth plan is refused; the table stays at eight and `next` stops at eight. -/
example : planCount (run init (.unlock :: List.replicate 9 (prep 0))) = 8 := by decide
example : (run init (.unlock :: List.replicate 9 (prep 0))).next = 8 := by decide

/-- Expired plans make room: after `ttl` a new prepare finds an empty table. -/
example : planCount (run init (.unlock :: List.replicate 8 (prep 0) ++ [prep 120000])) = 1 := by
  decide

/-- Cancel frees a slot. -/
example : planCount (run init (.unlock :: List.replicate 8 (prep 0) ++ [.cancel 3, prep 0])) = 8 := by
  decide

/-- Lock clears the table: the old id is unknown after unlock. -/
example : (run init [.unlock, prep 0, .lock, .unlock, .confirm 0 1 true]).log = [] := by decide
example : planCount (run init [.unlock, prep 0, prep 0, .lock]) = 0 := by decide

/-- Confirm on a locked wallet does nothing. -/
example : (run init [.unlock, prep 0, .lock, .confirm 0 1 true]).log = [] := by decide

/-- A chain mismatch at confirm consumes the plan and broadcasts nothing; a retry finds nothing. -/
example : (run init [.unlock, prep 0, .confirm 0 1 false, .confirm 0 2 true]).log = [] := by decide

/-- A chain mismatch at prepare creates no plan. -/
example : planCount (run init [.unlock, .prepare 0 false]) = 0 := by decide

/-- Two plans are confirmed independently, each once. -/
example : (run init [.unlock, prep 0, prep 0, .confirm 1 5 true, .confirm 0 5 true, .confirm 1 5 true]).log
    = [0, 1] := by decide

end TlDesktopCore.Session
