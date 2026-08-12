//! Seeded ChaCha8. Threaded explicitly through every call site.
//!
//! No thread-local generator and no system entropy anywhere in the core. A run is
//! defined by its seed, so anything that could draw from outside the seed would
//! break reproducibility.

use crate::fx::{ratio, Fx};
use rand::{RngExt, SeedableRng};
use rand_chacha::ChaCha8Rng;

pub struct Rng64 {
    inner: ChaCha8Rng,
}

impl Rng64 {
    pub fn from_seed(seed: u64) -> Self {
        Self {
            inner: ChaCha8Rng::seed_from_u64(seed),
        }
    }

    #[inline]
    pub fn next_u64(&mut self) -> u64 {
        self.inner.random::<u64>()
    }

    /// Uniform in `[0, n)`. Rejection sampled, so the result does not depend on
    /// float conversion or modulo bias.
    pub fn below(&mut self, n: u64) -> u64 {
        if n == 0 {
            return 0;
        }
        let zone = u64::MAX - (u64::MAX % n);
        loop {
            let v = self.next_u64();
            if v < zone {
                return v % n;
            }
        }
    }

    /// Uniform fixed-point value in `[0, 1)`, built from raw bits rather than a
    /// float division.
    pub fn unit(&mut self) -> Fx {
        let frac = self.next_u64() >> 32;
        Fx::from_bits(frac as i64)
    }

    /// True with probability `num/den`.
    pub fn chance(&mut self, num: u32, den: u32) -> bool {
        if den == 0 {
            return false;
        }
        self.unit() < ratio(num as i32, den as i32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fx::{from_int, Fx};

    #[test]
    fn same_seed_gives_same_sequence() {
        let mut a = Rng64::from_seed(42);
        let mut b = Rng64::from_seed(42);
        for _ in 0..256 {
            assert_eq!(a.next_u64(), b.next_u64());
        }
    }

    #[test]
    fn different_seeds_diverge() {
        let mut a = Rng64::from_seed(42);
        let mut b = Rng64::from_seed(43);
        let a: Vec<u64> = (0..32).map(|_| a.next_u64()).collect();
        let b: Vec<u64> = (0..32).map(|_| b.next_u64()).collect();
        assert_ne!(a, b);
    }

    #[test]
    fn seed_42_produces_pinned_sequence() {
        // pins the generator against an accidental swap of algorithm or crate major.
        // regenerate deliberately if the PRNG is ever intentionally changed.
        let mut r = Rng64::from_seed(42);
        let got: Vec<u64> = (0..4).map(|_| r.next_u64()).collect();
        assert_eq!(
            got,
            vec![
                12578764544318200737,
                17529487244874322312,
                7886285670807131020,
                11572758976476374866
            ]
        );
    }

    #[test]
    fn unit_stays_in_range() {
        let mut r = Rng64::from_seed(7);
        for _ in 0..4096 {
            let v = r.unit();
            assert!(v >= Fx::ZERO && v < from_int(1));
        }
    }

    #[test]
    fn below_stays_in_range() {
        let mut r = Rng64::from_seed(9);
        for _ in 0..4096 {
            assert!(r.below(10) < 10);
        }
        assert_eq!(r.below(0), 0);
    }

    #[test]
    fn chance_converges_to_configured_rate() {
        let mut r = Rng64::from_seed(11);
        let n = 20000;
        let hits = (0..n).filter(|_| r.chance(25, 100)).count();
        let rate = hits as f64 / n as f64;
        assert!((rate - 0.25).abs() < 0.02, "rate was {rate}");
    }

    #[test]
    fn chance_with_zero_denominator_is_false() {
        let mut r = Rng64::from_seed(3);
        assert!(!r.chance(1, 0));
    }
}
