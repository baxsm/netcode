//! The spike simulation: entities integrating velocity with friction, bouncing off
//! world bounds.
//!
//! There is no netcode here. Phase 0 only has to prove that a non-trivial amount of
//! fixed-point arithmetic produces bit-identical results across engines, so this is
//! deliberately small. The techniques land in phase 2.

use crate::fx::{clamp, from_int, ratio, to_bits, Fx};
use crate::hash::Hasher;
use crate::rng::Rng64;

/// Entity count is fixed at construction so the arena is allocated once. A
/// `memory.grow` mid-run is allowed to fail non-deterministically in Wasm, so the
/// run must never trigger one.
pub const MAX_ENTITIES: usize = 64;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Entity {
    pub x: Fx,
    pub y: Fx,
    pub vx: Fx,
    pub vy: Fx,
}

pub struct World {
    pub entities: Vec<Entity>,
    pub tick: u32,
    bounds: Fx,
    friction: Fx,
    rng: Rng64,
}

impl World {
    /// Entities are placed from the seeded generator, so the starting layout is part
    /// of what the seed determines.
    pub fn new(seed: u64, entity_count: usize) -> Self {
        let count = entity_count.min(MAX_ENTITIES);
        let mut rng = Rng64::from_seed(seed);
        let bounds = from_int(100);

        let mut entities = Vec::with_capacity(MAX_ENTITIES);
        for _ in 0..count {
            let x = rng.unit() * bounds * from_int(2) - bounds;
            let y = rng.unit() * bounds * from_int(2) - bounds;
            let vx = rng.unit() * from_int(4) - from_int(2);
            let vy = rng.unit() * from_int(4) - from_int(2);
            entities.push(Entity { x, y, vx, vy });
        }

        Self {
            entities,
            tick: 0,
            bounds,
            friction: ratio(999, 1000),
            rng,
        }
    }

    /// One fixed step. The caller owns the clock; nothing here reads real time.
    pub fn step(&mut self) {
        let dt = ratio(1, 64);
        let bounds = self.bounds;
        let friction = self.friction;

        for e in &mut self.entities {
            e.vx *= friction;
            e.vy *= friction;

            e.x += e.vx * dt;
            e.y += e.vy * dt;

            // reflect at the wall and clamp, so a fast entity cannot tunnel out and
            // integrate away toward an overflow
            if e.x < -bounds || e.x > bounds {
                e.vx = -e.vx;
                e.x = clamp(e.x, -bounds, bounds);
            }
            if e.y < -bounds || e.y > bounds {
                e.vy = -e.vy;
                e.y = clamp(e.y, -bounds, bounds);
            }
        }

        // a seeded impulse every 32 ticks keeps the system from settling into a
        // fixed point, so a late divergence still has motion to show up in
        if self.tick.is_multiple_of(32) {
            let n = self.entities.len();
            if n > 0 {
                let target = self.rng.below(n as u64) as usize;
                let ix = self.rng.unit() * from_int(4) - from_int(2);
                let iy = self.rng.unit() * from_int(4) - from_int(2);
                let e = &mut self.entities[target];
                e.vx += ix;
                e.vy += iy;
            }
        }

        self.tick += 1;
    }

    pub fn run(&mut self, ticks: u32) {
        for _ in 0..ticks {
            self.step();
        }
    }

    /// Hashes raw fixed-point bits, never converted values. Hashing a float
    /// conversion would mask exactly the divergence this is built to detect.
    pub fn state_hash(&self) -> u64 {
        let mut h = Hasher::new();
        h.write_u32(self.tick);
        h.write_u32(self.entities.len() as u32);
        for e in &self.entities {
            h.write_i64(to_bits(e.x));
            h.write_i64(to_bits(e.y));
            h.write_i64(to_bits(e.vx));
            h.write_i64(to_bits(e.vy));
        }
        h.finish()
    }
}

/// Runs a fresh world and returns its final hash. The whole Phase 0 gate reduces to
/// this function agreeing across engines.
pub fn run_to_hash(seed: u64, ticks: u32, entity_count: usize) -> u64 {
    let mut w = World::new(seed, entity_count);
    w.run(ticks);
    w.state_hash()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pins the simulation against its recorded output.
    ///
    /// Every other test here compares a run to another run, so a bug that shifts
    /// every result equally stays invisible to them. A one-bit change in the
    /// integrator passes all of them and fails this. These values are the same ones
    /// `tests/vectors.ts` checks the browsers against, so the Rust suite and the
    /// cross-engine gate cannot disagree about what correct means.
    ///
    /// Regenerate only when the simulation is deliberately changed, and update
    /// `tests/vectors.ts` in the same commit.
    #[test]
    fn pinned_hashes() {
        let cases: [(u64, u32, usize, u64); 7] = [
            (42, 600, 16, 12437711605233424538),
            (0, 600, 16, 12303115795811892721),
            (u64::MAX, 300, 8, 6045337531062695667),
            (7, 1000, 64, 371772212692087449),
            (99, 2000, 1, 7229280520226837599),
            (5, 0, 4, 7442660319107100209),
            (123456789, 5000, 32, 9848046739593345173),
        ];
        for (seed, ticks, entities, expected) in cases {
            assert_eq!(
                run_to_hash(seed, ticks, entities),
                expected,
                "seed={seed} ticks={ticks} entities={entities}"
            );
        }
    }

    #[test]
    fn same_seed_same_hash() {
        assert_eq!(run_to_hash(42, 600, 16), run_to_hash(42, 600, 16));
    }

    #[test]
    fn different_seed_different_hash() {
        assert_ne!(run_to_hash(42, 600, 16), run_to_hash(43, 600, 16));
    }

    #[test]
    fn hash_is_sensitive_to_tick_count() {
        assert_ne!(run_to_hash(42, 600, 16), run_to_hash(42, 601, 16));
    }

    #[test]
    fn split_run_matches_single_run() {
        let mut a = World::new(42, 16);
        a.run(600);

        let mut b = World::new(42, 16);
        b.run(250);
        b.run(350);

        assert_eq!(a.state_hash(), b.state_hash());
    }

    #[test]
    fn entities_stay_inside_bounds() {
        let mut w = World::new(5, 32);
        w.run(2000);
        let b = from_int(100);
        for e in &w.entities {
            assert!(e.x >= -b && e.x <= b, "x escaped: {}", e.x);
            assert!(e.y >= -b && e.y <= b, "y escaped: {}", e.y);
        }
    }

    #[test]
    fn entity_count_is_capped_to_arena() {
        let w = World::new(1, MAX_ENTITIES + 50);
        assert_eq!(w.entities.len(), MAX_ENTITIES);
    }

    #[test]
    fn zero_entities_does_not_panic() {
        let mut w = World::new(1, 0);
        w.run(100);
        assert_eq!(w.entities.len(), 0);
    }

    #[test]
    fn long_run_does_not_overflow() {
        // overflow-checks are on in test and release, so a wrap would panic here
        let mut w = World::new(77, MAX_ENTITIES);
        w.run(20000);
        assert_eq!(w.tick, 20000);
    }
}
