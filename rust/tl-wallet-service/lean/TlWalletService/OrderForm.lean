/-!
# Order form (models `orderform::{cost, max_for_budget, commitment, fee_estimate, fits, build_order}`)

Amounts are `Nat` base units (1e-8). Abstractions: the wallet UTXO list is given already sorted
largest first (Rust sorts it); balances and reservations are folded into one `avail` (balance minus
open-order reservations, floored at zero, `orderform::available`); the form-validity, key,
attestation and market checks of `build_order` are `Bool` guards in `accepts`; the LTC maximum is
the monotone search over `fitsLtc`.
-/
namespace TlWalletService.OrderForm

def COIN : Nat := 100000000
def FEE : Nat := 60000
def MINVOUT : Nat := 3600
def FORMMIN : Nat := 1000000

/-- `orderform::cost`: `ceil(a * p / 1e8)`. -/
def cost (a p : Nat) : Nat := (a * p + (COIN - 1)) / COIN

/-- `orderform::max_for_budget`: `floor(avail / p)` in base units (zero price: zero). -/
def maxBuy (avail p : Nat) : Nat := avail * COIN / p

/-- `orderform::commitment`: a spot SELL commits the base amount, everything else `cost`. -/
def commitment (spotSell : Bool) (a p : Nat) : Nat := if spotSell then a else cost a p

/-- `fee_estimate` loop: an input is taken while `sum < target + FEE * (taken + 1)`. -/
def countInputs (target : Nat) : Nat → Nat → List Nat → Nat
  | _, n, [] => n
  | s, n, u :: us =>
    if s < target + FEE * (n + 1) then countInputs target (s + u) (n + 1) us
    else countInputs target s n us

/-- `fee_estimate` for an LTC-funded order: the list carries the legacy phantom entry. -/
def feeLtc (target : Nat) (utxos : List Nat) : Nat :=
  FEE * countInputs target 0 0 (MINVOUT :: utxos)

/-- `fee_estimate` for a token-funded order: target is two minimum outputs, no phantom entry. -/
def feeToken (utxos : List Nat) : Nat := FEE * countInputs (2 * MINVOUT) 0 0 utxos

/-- `fits` for an order not funded by LTC. -/
def fitsToken (spotSell : Bool) (avail a p : Nat) : Bool :=
  decide (commitment spotSell a p ≤ avail)

/-- `fits` for an LTC-funded order: the commitment and the order's own fee must fit. -/
def fitsLtc (spotSell : Bool) (avail : Nat) (utxos : List Nat) (a p : Nat) : Bool :=
  decide (commitment spotSell a p +
    feeLtc (commitment spotSell a p + MINVOUT) utxos ≤ avail)

/-- `build_order` for a token-funded order: positive price and amount, both above the form
minimum, and the commitment within the available balance. -/
def accepts (spotSell : Bool) (avail a p : Nat) : Bool :=
  decide (FORMMIN ≤ a) && decide (FORMMIN ≤ p) && fitsToken spotSell avail a p

/-- `build_order` for an LTC-funded order. -/
def acceptsLtc (spotSell : Bool) (avail : Nat) (utxos : List Nat) (a p : Nat) : Bool :=
  decide (FORMMIN ≤ a) && decide (FORMMIN ≤ p) && fitsLtc spotSell avail utxos a p

-- ceiling / floor arithmetic ---------------------------------------------------------------

/-- The commitment of a BUY is never below the exact product `a * p / 1e8`. -/
theorem cost_ge (a p : Nat) : a * p ≤ cost a p * COIN := by
  unfold cost COIN
  generalize a * p = x
  omega

theorem cost_mono {a a' : Nat} (p : Nat) (h : a ≤ a') : cost a p ≤ cost a' p := by
  unfold cost COIN
  have : a * p ≤ a' * p := Nat.mul_le_mul_right p h
  omega

/-- The budget maximum is affordable: its (rounded up) cost fits the balance. -/
theorem maxBuy_affordable (avail p : Nat) : cost (maxBuy avail p) p ≤ avail := by
  have h1 : maxBuy avail p * p ≤ avail * COIN := by
    unfold maxBuy
    exact Nat.div_mul_le_self _ _
  unfold cost
  generalize maxBuy avail p * p = x at *
  unfold COIN at *
  omega

/-- ... and it is the largest such amount: one more unit costs more than the balance. -/
theorem maxBuy_maximal (avail p : Nat) (hp : 0 < p) : avail < cost (maxBuy avail p + 1) p := by
  have h1 : avail * COIN < p * (avail * COIN / p + 1) := Nat.lt_mul_div_succ _ hp
  have h2 : p * (maxBuy avail p + 1) = (maxBuy avail p + 1) * p := Nat.mul_comm _ _
  unfold maxBuy at *
  unfold cost
  generalize (avail * COIN / p + 1) * p = x at *
  unfold COIN at *
  omega

/-- A SELL reserves exactly the base amount (legacy reserved `amount * price`). -/
theorem sell_commits_amount (a p : Nat) : commitment true a p = a := by
  simp [commitment]

-- acceptance ---------------------------------------------------------------------------------

/-- An accepted token-funded order never commits more than the available balance. -/
theorem accepts_within_available (spotSell : Bool) (avail a p : Nat)
    (h : accepts spotSell avail a p = true) : commitment spotSell a p ≤ avail := by
  simp [accepts, fitsToken] at h
  exact h.2

/-- An accepted LTC-funded order covers its commitment and its own fee. -/
theorem acceptsLtc_within_available (spotSell : Bool) (avail : Nat) (utxos : List Nat) (a p : Nat)
    (h : acceptsLtc spotSell avail utxos a p = true) :
    commitment spotSell a p + feeLtc (commitment spotSell a p + MINVOUT) utxos ≤ avail := by
  simp [acceptsLtc, fitsLtc] at h
  exact h.2

/-- Accepted orders have a positive amount and price, at least the form minimum 0.01. -/
theorem accepts_positive (spotSell : Bool) (avail a p : Nat)
    (h : accepts spotSell avail a p = true) : 0 < a ∧ 0 < p ∧ FORMMIN ≤ a ∧ FORMMIN ≤ p := by
  simp [accepts] at h
  unfold FORMMIN at *
  omega

/-- The maximum offered for a buy is accepted whenever it reaches the form minimum. -/
theorem max_buy_accepted (avail p : Nat) (hpmin : FORMMIN ≤ p)
    (hmin : FORMMIN ≤ maxBuy avail p) : accepts false avail (maxBuy avail p) p = true := by
  have h := maxBuy_affordable avail p
  simp [accepts, fitsToken, commitment, hmin, hpmin, h]

/-- ... and one unit more is refused. -/
theorem max_buy_plus_one_refused (avail p : Nat) (hp : 0 < p) :
    accepts false avail (maxBuy avail p + 1) p = false := by
  have h := maxBuy_maximal avail p hp
  simp [accepts, fitsToken, commitment]
  intro _ _
  omega

-- fee estimate -------------------------------------------------------------------------------

theorem countInputs_ge (t : Nat) (l : List Nat) : ∀ s n, n ≤ countInputs t s n l := by
  induction l with
  | nil => intro s n; simp [countInputs]
  | cons u us ih =>
    intro s n
    simp only [countInputs]
    split
    · exact Nat.le_trans (Nat.le_succ n) (ih _ _)
    · exact ih _ _

theorem countInputs_le (t : Nat) (l : List Nat) : ∀ s n, countInputs t s n l ≤ n + l.length := by
  induction l with
  | nil => intro s n; simp [countInputs]
  | cons u us ih =>
    intro s n
    simp only [countInputs, List.length_cons]
    split
    · have := ih (s + u) (n + 1); omega
    · have := ih s n; omega

/-- Once the loop stops at some state it never takes another input. -/
theorem countInputs_stopped (t : Nat) (l : List Nat) :
    ∀ s n, ¬ s < t + FEE * (n + 1) → countInputs t s n l = n := by
  induction l with
  | nil => intro s n _; simp [countInputs]
  | cons u us ih =>
    intro s n h
    simp only [countInputs]
    rw [if_neg h]
    exact ih s n h

/-- A larger target never selects fewer inputs (what makes the maximum search monotone). -/
theorem countInputs_mono (l : List Nat) :
    ∀ {t1 t2 : Nat}, t1 ≤ t2 → ∀ s n, countInputs t1 s n l ≤ countInputs t2 s n l := by
  induction l with
  | nil => intro t1 t2 _ s n; simp [countInputs]
  | cons u us ih =>
    intro t1 t2 h s n
    simp only [countInputs]
    by_cases h1 : s < t1 + FEE * (n + 1)
    · have h2 : s < t2 + FEE * (n + 1) := by omega
      rw [if_pos h1, if_pos h2]
      exact ih h _ _
    · rw [if_neg h1]
      by_cases h2 : s < t2 + FEE * (n + 1)
      · rw [if_pos h2]
        rw [countInputs_stopped t1 us s n h1]
        exact Nat.le_trans (Nat.le_succ n) (countInputs_ge t2 us _ _)
      · rw [if_neg h2]
        exact ih h _ _

/-- The estimate never exceeds one fee per UTXO plus the phantom entry. -/
theorem feeLtc_bound (target : Nat) (utxos : List Nat) :
    feeLtc target utxos ≤ FEE * (utxos.length + 1) := by
  unfold feeLtc
  have := countInputs_le target (MINVOUT :: utxos) 0 0
  simp at this
  exact Nat.mul_le_mul_left _ this

/-- A bigger LTC-funded order never needs a smaller fee. -/
theorem feeLtc_mono {t1 t2 : Nat} (utxos : List Nat) (h : t1 ≤ t2) :
    feeLtc t1 utxos ≤ feeLtc t2 utxos := by
  unfold feeLtc
  exact Nat.mul_le_mul_left _ (countInputs_mono _ h _ _)

theorem commitment_mono (spotSell : Bool) {a a' : Nat} (p : Nat) (h : a ≤ a') :
    commitment spotSell a p ≤ commitment spotSell a' p := by
  unfold commitment
  split
  · exact h
  · exact cost_mono p h

/-- `fitsLtc` is downward closed in the amount: a smaller order fits whenever a larger one does.
This is what makes the binary search of `max_amount` find the largest fitting amount. -/
theorem fitsLtc_downward (spotSell : Bool) (avail : Nat) (utxos : List Nat) (p : Nat)
    {a a' : Nat} (h : a ≤ a') (hf : fitsLtc spotSell avail utxos a' p = true) :
    fitsLtc spotSell avail utxos a p = true := by
  have hc := commitment_mono spotSell p h
  have hfee := feeLtc_mono utxos (t1 := commitment spotSell a p + MINVOUT)
    (t2 := commitment spotSell a' p + MINVOUT) (by omega)
  simp only [fitsLtc, decide_eq_true_eq] at hf ⊢
  omega

-- vectors (the same numbers are asserted in tests/orderform.rs) ---------------------------

example : cost 66666666 30000000 = 20000000 := by decide
example : cost 66666667 30000000 = 20000001 := by decide
example : cost 66666700 30000000 = 20000010 := by decide   -- the legacy "max" of 0.2 / 0.3
example : maxBuy 20000000 30000000 = 66666666 := by decide
example : maxBuy 90000000 30000000 = 300000000 := by decide
example : cost 1 1 = 1 := by decide
-- token-funded handler: 20 tokens at price 2 -> at most 10 base units
example : accepts false 2000000000 1000000000 200000000 = true := by decide
example : accepts false 2000000000 1050000000 200000000 = false := by decide
example : accepts false 2000000000 999999 200000000 = false := by decide
-- SELL reservation: 4 at price 3 reserves 4 (legacy 12)
example : commitment true 400000000 300000000 = 400000000 := by decide
-- fee estimate: spot_ltc_quote_buy (0.75 LTC in 0.5 / 0.2 / 0.05)
example : feeLtc (10000000 + MINVOUT) [50000000, 20000000, 5000000] = 120000 := by decide
example : feeLtc (74880000 + MINVOUT) [50000000, 20000000, 5000000] = 240000 := by decide
-- SELL of 2 LTC from three 1.0 inputs (legacy target was 0.2): phantom + 3 inputs
example : feeLtc (200000000 + MINVOUT) [100000000, 100000000, 100000000] = 240000 := by decide
example : feeLtc (20000000 + MINVOUT) [100000000, 100000000, 100000000] = 120000 := by decide
-- token path: one 0.01 input covers two minimum outputs
example : feeToken [1000000, 200000] = 60000 := by decide
-- LTC maximum for 1.0 LTC in one input at price 0.5: 199 760 000 fits, one more does not
example : fitsLtc false 100000000 [100000000] 199760000 50000000 = true := by decide
example : fitsLtc false 100000000 [100000000] 199760001 50000000 = false := by decide

end TlWalletService.OrderForm
