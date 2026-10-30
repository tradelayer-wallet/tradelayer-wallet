/-!
# Transaction planner (models `src/txbuilder.rs`: `select`, `plan_payment`, `plan_instant_trade`)

Abstractions: UTXOs are represented by their amounts in base units (`Nat`); the candidate list is
already in candidate order (supplied inputs first, wallet outputs largest first, duplicates
removed -- `candidate_order`, tested in Rust). `Option` stands for `Result<_, PlanError>`.
-/
namespace TlWalletService.TxBuilder

/-- `FEE_PER_INPUT_SAT` (0.3 * 0.002 coin). -/
def feePer : Nat := 60000
/-- `MAX_INPUTS`. -/
def maxInputs : Nat := 100

def need (target n : Nat) (feeAware : Bool) : Nat :=
  if feeAware then target + feePer * n else target

/-- Greedy selection (`select`): the first `m` candidates are mandatory; after that, stop as soon
as the chosen sum covers `target` (plus the fee of the chosen inputs when `feeAware`). -/
def selectAux (target : Nat) (feeAware : Bool) : Nat → List Nat → List Nat → List Nat
  | _, chosen, [] => chosen
  | m + 1, chosen, u :: us => selectAux target feeAware m (chosen ++ [u]) us
  | 0, chosen, u :: us =>
    if need target chosen.length feeAware ≤ chosen.sum then chosen
    else selectAux target feeAware 0 (chosen ++ [u]) us

/-- The selection is always a prefix of the candidates and contains every mandatory one. -/
theorem selectAux_eq_take (target : Nat) (fa : Bool) (l : List Nat) :
    ∀ (m : Nat) (c : List Nat), ∃ k, selectAux target fa m c l = c ++ l.take k ∧
      min m l.length ≤ k := by
  induction l with
  | nil => intro m c; exact ⟨0, by simp [selectAux]⟩
  | cons u us ih =>
    intro m c
    cases m with
    | succ m =>
      obtain ⟨k, hk, hm⟩ := ih m (c ++ [u])
      refine ⟨k + 1, ?_, by simp; omega⟩
      simp [selectAux, hk]
    | zero =>
      unfold selectAux
      split
      · exact ⟨0, by simp⟩
      · obtain ⟨k, hk, hm⟩ := ih 0 (c ++ [u])
        refine ⟨k + 1, ?_, by simp⟩
        simp [hk]

theorem selectAux_prefix (target : Nat) (fa : Bool) (m : Nat) (l : List Nat) :
    selectAux target fa m [] l <+: l := by
  obtain ⟨k, hk, _⟩ := selectAux_eq_take target fa l m []
  rw [hk]
  simpa using List.take_prefix k l

theorem selectAux_mandatory (target : Nat) (fa : Bool) (mand extras : List Nat) :
    mand <+: selectAux target fa mand.length [] (mand ++ extras) := by
  obtain ⟨k, hk, hm⟩ := selectAux_eq_take target fa (mand ++ extras) mand.length []
  have hle : mand.length ≤ (mand ++ extras).length := by simp
  have hmk : mand.length ≤ k := by
    have : min mand.length (mand ++ extras).length = mand.length := Nat.min_eq_left hle
    omega
  rw [hk]
  obtain ⟨d, rfl⟩ := Nat.exists_eq_add_of_le hmk
  have h1 : (mand ++ extras).take mand.length = mand := by simp
  refine ⟨((mand ++ extras).drop mand.length).take d, ?_⟩
  simp only [List.nil_append]
  rw [List.take_add, h1]

structure Plan where
  inputs : List Nat
  to : Nat
  change : Nat
  fee : Nat
  deriving DecidableEq, Repr

def finishPayment (minOut amount : Nat) (hasPayload : Bool) (chosen : List Nat) : Option Plan :=
  if chosen.isEmpty || chosen.length > maxInputs then none
  else if hasPayload then
    -- sender pays the fee out of the change
    if chosen.sum < amount + feePer * chosen.length then none
    else some ⟨chosen, amount, chosen.sum - (amount + feePer * chosen.length),
      feePer * chosen.length⟩
  else
    -- recipient pays the fee out of the amount
    if amount < feePer * chosen.length || amount - feePer * chosen.length < minOut ||
        chosen.sum < amount then none
    else some ⟨chosen, amount - feePer * chosen.length, chosen.sum - amount,
      feePer * chosen.length⟩

/-- `amount = max(amount.unwrap_or(0), min_out)`. -/
def amountOf (minOut : Nat) (amt : Option Nat) : Nat := max (amt.getD 0) minOut

/-- Legacy "Minimum amount is" rejection: only when an amount is given and no payload. -/
def belowMin (minOut : Nat) (amt : Option Nat) : Bool :=
  match amt with
  | some a => decide (minOut > a)
  | none => false

/-- `plan_payment`. -/
def planPayment (minOut : Nat) (amt : Option Nat) (hasPayload : Bool) (cands : List Nat) :
    Option Plan :=
  if belowMin minOut amt && !hasPayload then none
  else
    finishPayment minOut (amountOf minOut amt) hasPayload
      (selectAux (amountOf minOut amt) hasPayload 0 [] cands)

/-- Value conservation: inputs = recipient output + change + fee. -/
theorem finishPayment_conserves (minOut amount : Nat) (hp : Bool) (chosen : List Nat) (p : Plan)
    (h : finishPayment minOut amount hp chosen = some p) :
    p.inputs.sum = p.to + p.change + p.fee := by
  unfold finishPayment at h
  split at h
  · simp at h
  · split at h
    · split at h
      · simp at h
      · next hlt =>
        simp at h; subst h; simp; omega
    · split at h
      · simp at h
      · next hc2 =>
        simp at h; subst h; simp
        simp [Bool.or_eq_true] at hc2
        omega

theorem finishPayment_fee_exact (minOut amount : Nat) (hp : Bool) (chosen : List Nat) (p : Plan)
    (h : finishPayment minOut amount hp chosen = some p) :
    p.fee = feePer * p.inputs.length := by
  unfold finishPayment at h
  split at h
  · simp at h
  · split at h
    · split at h
      · simp at h
      · simp at h; subst h; rfl
    · split at h
      · simp at h
      · simp at h; subst h; rfl

/-- Fee bound: the fee never exceeds `feePer * maxInputs`. -/
theorem finishPayment_fee_bound (minOut amount : Nat) (hp : Bool) (chosen : List Nat) (p : Plan)
    (h : finishPayment minOut amount hp chosen = some p) :
    p.fee ≤ feePer * maxInputs := by
  have hexact := finishPayment_fee_exact minOut amount hp chosen p h
  have hlen : p.inputs.length ≤ maxInputs := by
    unfold finishPayment at h
    split at h
    · simp at h
    · next hc =>
      simp [Bool.or_eq_true] at hc
      split at h
      · split at h
        · simp at h
        · simp at h; subst h; simp; omega
      · split at h
        · simp at h
        · simp at h; subst h; simp; omega
  rw [hexact]
  exact Nat.mul_le_mul_left _ hlen

theorem finishPayment_nonempty (minOut amount : Nat) (hp : Bool) (chosen : List Nat) (p : Plan)
    (h : finishPayment minOut amount hp chosen = some p) : p.inputs ≠ [] := by
  unfold finishPayment at h
  split at h
  · simp at h
  · next hc =>
    simp [Bool.or_eq_true] at hc
    split at h
    · split at h
      · simp at h
      · simp at h; subst h; simpa using hc.1
    · split at h
      · simp at h
      · simp at h; subst h; simpa using hc.1

/-- The recipient always receives at least the minimum output (no silent clamping). -/
theorem finishPayment_to_ge_min (minOut amount : Nat) (hp : Bool) (chosen : List Nat) (p : Plan)
    (hge : minOut ≤ amount) (h : finishPayment minOut amount hp chosen = some p) :
    minOut ≤ p.to := by
  unfold finishPayment at h
  split at h
  · simp at h
  · split at h
    · split at h
      · simp at h
      · simp at h; subst h; simpa using hge
    · split at h
      · simp at h
      · next hc =>
        simp [Bool.or_eq_true] at hc
        simp at h; subst h; simp; omega

theorem finishPayment_prefix (minOut amount : Nat) (hp : Bool) (chosen : List Nat) (p : Plan)
    (h : finishPayment minOut amount hp chosen = some p) : p.inputs = chosen := by
  unfold finishPayment at h
  split at h
  · simp at h
  · split at h
    · split at h
      · simp at h
      · simp at h; subst h; rfl
    · split at h
      · simp at h
      · simp at h; subst h; rfl

theorem planPayment_some (minOut : Nat) (amt : Option Nat) (hp : Bool) (cands : List Nat)
    (p : Plan) (h : planPayment minOut amt hp cands = some p) :
    finishPayment minOut (amountOf minOut amt) hp
      (selectAux (amountOf minOut amt) hp 0 [] cands) = some p := by
  unfold planPayment at h
  split at h
  · simp at h
  · exact h

theorem planPayment_conserves (minOut : Nat) (amt : Option Nat) (hp : Bool) (cands : List Nat)
    (p : Plan) (h : planPayment minOut amt hp cands = some p) :
    p.inputs.sum = p.to + p.change + p.fee :=
  finishPayment_conserves _ _ _ _ p (planPayment_some minOut amt hp cands p h)

theorem planPayment_fee_exact (minOut : Nat) (amt : Option Nat) (hp : Bool) (cands : List Nat)
    (p : Plan) (h : planPayment minOut amt hp cands = some p) :
    p.fee = feePer * p.inputs.length :=
  finishPayment_fee_exact _ _ _ _ p (planPayment_some minOut amt hp cands p h)

theorem planPayment_fee_bound (minOut : Nat) (amt : Option Nat) (hp : Bool) (cands : List Nat)
    (p : Plan) (h : planPayment minOut amt hp cands = some p) :
    p.fee ≤ feePer * maxInputs :=
  finishPayment_fee_bound _ _ _ _ p (planPayment_some minOut amt hp cands p h)

theorem planPayment_nonempty (minOut : Nat) (amt : Option Nat) (hp : Bool) (cands : List Nat)
    (p : Plan) (h : planPayment minOut amt hp cands = some p) : p.inputs ≠ [] :=
  finishPayment_nonempty _ _ _ _ p (planPayment_some minOut amt hp cands p h)

theorem planPayment_to_ge_min (minOut : Nat) (amt : Option Nat) (hp : Bool) (cands : List Nat)
    (p : Plan) (h : planPayment minOut amt hp cands = some p) : minOut ≤ p.to :=
  finishPayment_to_ge_min _ _ _ _ p (Nat.le_max_right _ _) (planPayment_some minOut amt hp cands p h)

/-- The selected inputs are a prefix of the candidate order. -/
theorem planPayment_inputs_prefix (minOut : Nat) (amt : Option Nat) (hp : Bool)
    (cands : List Nat) (p : Plan) (h : planPayment minOut amt hp cands = some p) :
    p.inputs <+: cands := by
  have e := finishPayment_prefix _ _ _ _ p (planPayment_some minOut amt hp cands p h)
  rw [e]
  exact selectAux_prefix _ _ _ _

structure IPlan where
  inputs : List Nat
  seller : Nat
  change : Nat
  fee : Nat
  deriving DecidableEq, Repr

/-- Buyer output of the instant trade: the leftover, but at least the minimum output. -/
def chg (total seller fee minOut : Nat) : Nat :=
  if total - seller - fee > minOut then total - seller - fee else minOut

theorem chg_ge_min (total seller fee minOut : Nat) : minOut ≤ chg total seller fee minOut := by
  unfold chg; split <;> omega

/-- When the guard `fee + seller + change <= total` holds, the three outputs plus fee are exact. -/
theorem chg_exact (total seller fee minOut : Nat)
    (h : fee + seller + chg total seller fee minOut ≤ total) :
    total = seller + chg total seller fee minOut + fee := by
  unfold chg at *; split at h <;> split <;> omega

def finishInstant (minOut seller : Nat) (chosen : List Nat) : Option IPlan :=
  if chosen.isEmpty || chosen.length > maxInputs then none
  else if chosen.sum < feePer * chosen.length + seller +
      chg chosen.sum seller (feePer * chosen.length) minOut then none
  else some ⟨chosen, seller, chg chosen.sum seller (feePer * chosen.length) minOut,
    feePer * chosen.length⟩

/-- `plan_instant_trade`: commit UTXOs are mandatory, wallet UTXOs follow. -/
def planInstant (minOut amount : Nat) (mandatory extras : List Nat) : Option IPlan :=
  finishInstant minOut (max amount minOut)
    (selectAux (minOut + max amount minOut) true mandatory.length [] (mandatory ++ extras))

theorem finishInstant_conserves (minOut seller : Nat) (chosen : List Nat) (p : IPlan)
    (h : finishInstant minOut seller chosen = some p) :
    p.inputs.sum = p.seller + p.change + p.fee := by
  unfold finishInstant at h
  split at h
  · simp at h
  · next hc =>
    split at h
    · simp at h
    · next hg =>
      simp at h; subst h
      have := chg_exact chosen.sum seller (feePer * chosen.length) minOut (by omega)
      simp; omega

theorem finishInstant_fee_exact (minOut seller : Nat) (chosen : List Nat) (p : IPlan)
    (h : finishInstant minOut seller chosen = some p) :
    p.fee = feePer * p.inputs.length := by
  unfold finishInstant at h
  split at h
  · simp at h
  · split at h
    · simp at h
    · simp at h; subst h; rfl

theorem finishInstant_buyer_min (minOut seller : Nat) (chosen : List Nat) (p : IPlan)
    (h : finishInstant minOut seller chosen = some p) : minOut ≤ p.change := by
  unfold finishInstant at h
  split at h
  · simp at h
  · split at h
    · simp at h
    · simp at h; subst h
      exact chg_ge_min _ _ _ _

theorem finishInstant_inputs (minOut seller : Nat) (chosen : List Nat) (p : IPlan)
    (h : finishInstant minOut seller chosen = some p) : p.inputs = chosen := by
  unfold finishInstant at h
  split at h
  · simp at h
  · split at h
    · simp at h
    · simp at h; subst h; rfl

theorem planInstant_conserves (minOut amount : Nat) (mandatory extras : List Nat) (p : IPlan)
    (h : planInstant minOut amount mandatory extras = some p) :
    p.inputs.sum = p.seller + p.change + p.fee :=
  finishInstant_conserves _ _ _ p h

/-- Every commit UTXO is spent by the instant-trade transaction, whatever else is selected. -/
theorem planInstant_keeps_commit_utxos (minOut amount : Nat) (mandatory extras : List Nat)
    (p : IPlan) (h : planInstant minOut amount mandatory extras = some p) :
    mandatory <+: p.inputs := by
  have e := finishInstant_inputs _ _ _ p h
  rw [e]
  exact selectAux_mandatory _ _ _ _

/-! ### Vectors shared with `tests/txbuilder.rs` -/

-- A: recipient pays fee; wallet [50M, 20M, 5M] already in candidate (largest first) order
example : planPayment 3600 (some 10000000) false [50000000, 20000000, 5000000] =
    some ⟨[50000000], 9940000, 40000000, 60000⟩ := by decide
-- B: payload carrier, sender pays fee; no extra input is selected
example : planPayment 3600 none true [100000, 50000] = some ⟨[100000], 3600, 36400, 60000⟩ := by
  decide
-- C: instant trade with two mandatory commit UTXOs
example : planInstant 3600 0 [3600, 3600] [1000000] =
    some ⟨[3600, 3600, 1000000], 3600, 823600, 180000⟩ := by decide
-- repaired: the second commit UTXO is kept although the first alone covers the target
example : planInstant 3600 0 [1000000, 3600] [5000000] =
    some ⟨[1000000, 3600], 3600, 880000, 120000⟩ := by decide
-- repaired: no extra input
example : (planPayment 3600 none true [100000, 90000]).map (·.inputs.length) = some 1 := by decide
-- errors
example : planPayment 3600 (some 1000) false [1000000] = none := by decide
example : planPayment 3600 none false [1000000] = none := by decide
example : planPayment 3600 (some 100000) false [50000] = none := by decide
example : planPayment 3600 none true [53600] = none := by decide
example : planPayment 3600 (some 50000) false [1000000] = none := by decide
example : planPayment 3600 (some 100000) false [] = none := by decide
-- instant trade: buyer output clamped to the minimum, and the boundary one satoshi short
example : planInstant 3600 30000 [93600] [] = some ⟨[93600], 30000, 3600, 60000⟩ := by decide
example : planInstant 3600 30000 [93599] [] = none := by decide
example : planInstant 3600 30000 [100000] [] = some ⟨[100000], 30000, 10000, 60000⟩ := by decide
-- repaired: payload tx does not charge the fee twice
example : planPayment 3600 (some 1000000) true [10000000] =
    some ⟨[10000000], 1000000, 8940000, 60000⟩ := by decide

end TlWalletService.TxBuilder
