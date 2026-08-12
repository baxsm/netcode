//! Q32.32 fixed point. The simulation's only numeric type.
//!
//! Floats are banned inside the simulation because `Math.sin` and friends are
//! implementation-defined in JS, and IEEE transcendentals are not bit-portable
//! across targets in Rust either. Fixed point removes the category rather than
//! negotiating with it.

use fixed::types::I32F32;

pub type Fx = I32F32;

/// Raw bit pattern. Hashing goes through this, never through a float.
#[inline]
pub fn to_bits(v: Fx) -> i64 {
    v.to_bits()
}

#[inline]
pub fn from_bits(bits: i64) -> Fx {
    Fx::from_bits(bits)
}

#[inline]
pub fn from_int(n: i32) -> Fx {
    Fx::from_num(n)
}

/// Numerator over denominator, evaluated in fixed point. Used instead of
/// writing decimal literals, which would route through a float parse.
#[inline]
pub fn ratio(num: i32, den: i32) -> Fx {
    Fx::from_num(num) / Fx::from_num(den)
}

/// Leaves the simulation only for display. Never call this inside a tick.
#[inline]
pub fn to_f64_for_display(v: Fx) -> f64 {
    v.to_num::<f64>()
}

/// Saturating so a runaway value clamps at the bound instead of trapping mid-run.
/// Overflow inside the integrator is a bug and traps; clamping here is intended.
#[inline]
pub fn clamp(v: Fx, lo: Fx, hi: Fx) -> Fx {
    if v < lo {
        lo
    } else if v > hi {
        hi
    } else {
        v
    }
}

#[inline]
pub fn abs(v: Fx) -> Fx {
    if v < Fx::ZERO {
        // I32F32::MIN has no positive counterpart, so negating it would trap
        v.checked_neg().unwrap_or(Fx::MAX)
    } else {
        v
    }
}

/// Integer square root on the fixed-point representation, by Newton's method.
///
/// `fixed` ships `sqrt` only on unsigned types, and the float `sqrt` is exactly
/// the kind of call that breaks bit-portability. This is deterministic because
/// it is pure integer arithmetic with a fixed iteration bound.
pub fn sqrt(v: Fx) -> Fx {
    if v <= Fx::ZERO {
        return Fx::ZERO;
    }
    // operate on the raw i64 as a Q32.32 value: sqrt(x * 2^32) = sqrt(x) * 2^16,
    // so the result needs shifting left by 16 to land back in Q32.32
    let bits = v.to_bits() as u64;
    let mut lo: u64 = 0;
    let mut hi: u64 = u32::MAX as u64;
    while lo < hi {
        let mid = lo + (hi - lo).div_ceil(2);
        if mid.saturating_mul(mid) <= bits {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    Fx::from_bits((lo << 16) as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ratio_is_exact_for_powers_of_two() {
        assert_eq!(ratio(1, 2), Fx::from_bits(1i64 << 31));
        assert_eq!(ratio(1, 4), Fx::from_bits(1i64 << 30));
    }

    #[test]
    fn bit_roundtrip_preserves_value() {
        let v = ratio(7, 3);
        assert_eq!(from_bits(to_bits(v)), v);
    }

    #[test]
    fn sqrt_of_perfect_squares() {
        assert_eq!(sqrt(from_int(4)), from_int(2));
        assert_eq!(sqrt(from_int(9)), from_int(3));
        assert_eq!(sqrt(from_int(144)), from_int(12));
    }

    #[test]
    fn sqrt_of_zero_and_negative_is_zero() {
        assert_eq!(sqrt(Fx::ZERO), Fx::ZERO);
        assert_eq!(sqrt(from_int(-5)), Fx::ZERO);
    }

    #[test]
    fn sqrt_is_close_for_non_squares() {
        // squaring the result must land back near the input, which checks accuracy
        // without writing an approximate constant
        let r = sqrt(from_int(2));
        assert!(abs(r * r - from_int(2)) < ratio(1, 1000));
    }

    #[test]
    fn clamp_bounds_both_directions() {
        assert_eq!(clamp(from_int(5), from_int(0), from_int(3)), from_int(3));
        assert_eq!(clamp(from_int(-5), from_int(0), from_int(3)), from_int(0));
        assert_eq!(clamp(from_int(2), from_int(0), from_int(3)), from_int(2));
    }

    #[test]
    fn abs_handles_min_without_trapping() {
        assert_eq!(abs(Fx::MIN), Fx::MAX);
        assert_eq!(abs(from_int(-7)), from_int(7));
    }
}
