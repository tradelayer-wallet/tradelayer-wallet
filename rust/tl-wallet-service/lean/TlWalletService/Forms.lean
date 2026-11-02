/-!
# Transaction forms (models `txforms::{Stepper, AddressCheck, withdraw_request}`)

Abstractions: the withdraw amount is already parsed to base units (`parse_positive_amount`); the
address check state is the four-valued `AddressCheck`; key slots, pubkey validity and the HOT-slot
rule of `MultisigForm` are covered by the Rust tests only.
-/
namespace TlWalletService.Forms

-- multisig key-count stepper -------------------------------------------------------------------

structure Stepper where
  nReq : Nat
  nAll : Nat
  deriving DecidableEq, Repr

def Stepper.Inv (s : Stepper) : Prop := 2 ≤ s.nReq ∧ s.nReq ≤ s.nAll ∧ s.nAll ≤ 7

def Stepper.reqUp (s : Stepper) : Stepper :=
  if s.nReq < s.nAll then { s with nReq := s.nReq + 1 } else s

def Stepper.reqDown (s : Stepper) : Stepper :=
  if 2 < s.nReq then { s with nReq := s.nReq - 1 } else s

def Stepper.allUp (s : Stepper) : Stepper :=
  if s.nAll < 7 then { s with nAll := s.nAll + 1 } else s

def Stepper.allDown (s : Stepper) : Stepper :=
  if 2 < s.nAll then { nReq := min s.nReq (s.nAll - 1), nAll := s.nAll - 1 } else s

theorem reqUp_inv (s : Stepper) (h : s.Inv) : s.reqUp.Inv := by
  unfold Stepper.reqUp Stepper.Inv at *
  split <;> simp_all <;> omega

theorem reqDown_inv (s : Stepper) (h : s.Inv) : s.reqDown.Inv := by
  unfold Stepper.reqDown Stepper.Inv at *
  split <;> simp_all <;> omega

theorem allUp_inv (s : Stepper) (h : s.Inv) : s.allUp.Inv := by
  unfold Stepper.allUp Stepper.Inv at *
  split <;> simp_all <;> omega

theorem allDown_inv (s : Stepper) (h : s.Inv) : s.allDown.Inv := by
  unfold Stepper.allDown Stepper.Inv at *
  split <;> simp_all <;> omega

-- address check -----------------------------------------------------------------------------

inductive Check | unchecked | pending | valid | invalid
  deriving DecidableEq, Repr

def Check.allowsBuild : Check → Bool
  | .valid => true
  | _ => false

/-- Editing the address resets the check: a new address is never built before validation. -/
def Check.edited (_ : Check) : Check := .unchecked

theorem edited_blocks_build (c : Check) : c.edited.allowsBuild = false := rfl

theorem only_valid_builds (c : Check) (h : c.allowsBuild = true) : c = .valid := by
  cases c <;> simp_all [Check.allowsBuild]

-- withdraw ----------------------------------------------------------------------------------

def WITHDRAW_MIN : Nat := 100000

/-- `withdraw_request` acceptance on parsed values: validated recipient, positive amount of at
least 0.001, at most the balance. -/
def withdrawOk (c : Check) (amount maxv : Nat) : Bool :=
  c.allowsBuild && decide (0 < amount) && decide (WITHDRAW_MIN ≤ amount) && decide (amount ≤ maxv)

theorem withdraw_needs_validated_recipient (c : Check) (a m : Nat)
    (h : withdrawOk c a m = true) : c = .valid := by
  simp [withdrawOk] at h
  exact only_valid_builds c h.1.1.1

theorem withdraw_within_bounds (c : Check) (a m : Nat) (h : withdrawOk c a m = true) :
    WITHDRAW_MIN ≤ a ∧ a ≤ m := by
  simp [withdrawOk] at h
  exact ⟨h.1.2, h.2⟩

-- vectors (asserted in tests/txforms.rs) ----------------------------------------------------
example : (Stepper.mk 2 2).reqUp = ⟨2, 2⟩ := by decide
example : (Stepper.mk 2 2).reqDown = ⟨2, 2⟩ := by decide
example : (Stepper.mk 7 7).allUp = ⟨7, 7⟩ := by decide
example : (Stepper.mk 7 7).allDown = ⟨6, 6⟩ := by decide
example : (Stepper.mk 2 2).allDown = ⟨2, 2⟩ := by decide
example : withdrawOk .valid 100000 100000000 = true := by decide
example : withdrawOk .valid 99999 100000000 = false := by decide
example : withdrawOk .valid 100000001 100000000 = false := by decide
example : withdrawOk .unchecked 100000 100000000 = false := by decide

end TlWalletService.Forms
