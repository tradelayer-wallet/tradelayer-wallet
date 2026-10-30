//! Checked integer money. The legacy code used `parseFloat(x.toFixed(8))` (`safeNumber`) on JS
//! doubles; here every value is an integer count of 1e-8 coin units ("sat").

use std::fmt;

/// 1 coin in base units.
pub const COIN: u64 = 100_000_000;
/// Upper bound for any single amount or sum (84M coins, Litecoin's cap; also bounds Bitcoin).
pub const MAX_MONEY: u64 = 84_000_000 * COIN;

#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct Amount(u64);

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum AmountError {
    Malformed,
    Negative,
    TooManyDecimals,
    OutOfRange,
    Underflow,
    NotFinite,
}

impl fmt::Display for AmountError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            AmountError::Malformed => "malformed amount",
            AmountError::Negative => "negative amount",
            AmountError::TooManyDecimals => "more than 8 decimal places",
            AmountError::OutOfRange => "amount out of range",
            AmountError::Underflow => "amount underflow",
            AmountError::NotFinite => "amount is not finite",
        };
        f.write_str(s)
    }
}

impl std::error::Error for AmountError {}

impl Amount {
    pub const ZERO: Amount = Amount(0);

    pub fn from_sat(sat: u64) -> Result<Amount, AmountError> {
        if sat > MAX_MONEY {
            Err(AmountError::OutOfRange)
        } else {
            Ok(Amount(sat))
        }
    }

    pub fn sat(self) -> u64 {
        self.0
    }

    pub fn checked_add(self, o: Amount) -> Result<Amount, AmountError> {
        match self.0.checked_add(o.0) {
            Some(v) => Amount::from_sat(v),
            None => Err(AmountError::OutOfRange),
        }
    }

    pub fn checked_sub(self, o: Amount) -> Result<Amount, AmountError> {
        self.0
            .checked_sub(o.0)
            .map(Amount)
            .ok_or(AmountError::Underflow)
    }

    pub fn checked_mul(self, n: u64) -> Result<Amount, AmountError> {
        match self.0.checked_mul(n) {
            Some(v) => Amount::from_sat(v),
            None => Err(AmountError::OutOfRange),
        }
    }

    /// Parse a plain decimal such as `0.0006` or `12` (no sign, no exponent, at most 8 decimals).
    pub fn parse_coin(s: &str) -> Result<Amount, AmountError> {
        let s = s.trim();
        if s.is_empty() {
            return Err(AmountError::Malformed);
        }
        if s.starts_with('-') {
            return Err(AmountError::Negative);
        }
        let (int_part, frac_part) = match s.split_once('.') {
            Some((i, f)) => (i, f),
            None => (s, ""),
        };
        if int_part.is_empty() && frac_part.is_empty() {
            return Err(AmountError::Malformed);
        }
        let digits_ok = |p: &str| p.bytes().all(|b| b.is_ascii_digit());
        if !digits_ok(int_part) || !digits_ok(frac_part) || int_part.len() > 12 {
            return Err(AmountError::Malformed);
        }
        if frac_part.len() > 8 {
            return Err(AmountError::TooManyDecimals);
        }
        let int_v: u64 = if int_part.is_empty() {
            0
        } else {
            int_part.parse().map_err(|_| AmountError::Malformed)?
        };
        let mut frac = frac_part.to_string();
        while frac.len() < 8 {
            frac.push('0');
        }
        let frac_v: u64 = frac.parse().map_err(|_| AmountError::Malformed)?;
        let total = int_v
            .checked_mul(COIN)
            .and_then(|v| v.checked_add(frac_v))
            .ok_or(AmountError::OutOfRange)?;
        Amount::from_sat(total)
    }

    /// Canonical decimal text with exactly 8 decimals.
    pub fn to_coin_string(self) -> String {
        format!("{}.{:08}", self.0 / COIN, self.0 % COIN)
    }

    /// Convert an RPC JSON number (an f64) the way legacy `safeNumber(x, 8)` did: round to 8
    /// decimals. Negative, non-finite and out-of-range values are rejected.
    pub fn from_coin_f64(v: f64) -> Result<Amount, AmountError> {
        if !v.is_finite() {
            return Err(AmountError::NotFinite);
        }
        if v < 0.0 {
            return Err(AmountError::Negative);
        }
        if v > (MAX_MONEY / COIN) as f64 {
            return Err(AmountError::OutOfRange);
        }
        Amount::parse_coin(&format!("{v:.8}"))
    }

    /// The JSON number the node expects for `createrawtransaction`.
    pub fn to_json_number(self) -> serde_json::Value {
        match serde_json::Number::from_f64(self.0 as f64 / COIN as f64) {
            Some(n) => serde_json::Value::Number(n),
            None => serde_json::Value::Null,
        }
    }
}
