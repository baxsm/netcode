//! What is being simulated, and under what conditions.
//!
//! Everything here crosses into the simulation, so every field is fixed point or an
//! integer. Tick rate is data on `Scenario` rather than a constant anywhere, because
//! a client simulating at a different rate to the server is the drift Riot documents
//! and the thing this tool has to be able to reproduce.

use crate::fx::{from_int, ratio, Fx};
use crate::hash::Hasher;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum EntityKind {
    Player,
    Projectile,
    Static,
}

impl EntityKind {
    fn tag(self) -> u8 {
        match self {
            EntityKind::Player => 0,
            EntityKind::Projectile => 1,
            EntityKind::Static => 2,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum InputAction {
    Move { dx: Fx, dy: Fx },
    Fire { dir_x: Fx, dir_y: Fx },
    Stop,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct InputEvent {
    pub tick: u32,
    pub entity_id: u16,
    pub action: InputAction,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct EntitySpec {
    pub id: u16,
    pub kind: EntityKind,
    pub start_x: Fx,
    pub start_y: Fx,
    pub max_speed: Fx,
    pub accel: Fx,
    pub radius: Fx,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct WorldConfig {
    pub bounds_x: Fx,
    pub bounds_y: Fx,
    pub friction: Fx,
    pub gravity: Fx,
}

impl Default for WorldConfig {
    fn default() -> Self {
        Self {
            bounds_x: from_int(100),
            bounds_y: from_int(100),
            friction: ratio(985, 1000),
            gravity: Fx::ZERO,
        }
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Scenario {
    pub tick_rate: u32,
    pub duration_ticks: u32,
    pub world: WorldConfig,
    pub entities: Vec<EntitySpec>,
    /// Sorted by tick. `Sim` relies on that ordering to apply inputs at their
    /// scheduled tick rather than when they happen to be read.
    pub input_script: Vec<InputEvent>,
}

/// Named separately from the tick rate so a scenario that changes rate keeps its
/// wall-clock duration meaningful.
impl Scenario {
    /// Milliseconds per tick as fixed point. The virtual clock is this multiplied by
    /// the tick counter, so nothing ever reads a real clock.
    pub fn tick_interval_ms(&self) -> Fx {
        if self.tick_rate == 0 {
            return Fx::ZERO;
        }
        ratio(1000, self.tick_rate as i32)
    }

    /// How close the server and the client's view must be for a shot to register.
    ///
    /// Taken from the firing entity's radius rather than a constant, so a scenario
    /// with a larger body is not judged against a hitbox it does not have.
    pub fn hit_tolerance(&self) -> Fx {
        self.entities.first().map_or(Fx::ZERO, |e| e.radius)
    }

    pub fn ticks_for_ms(&self, ms: u32) -> u32 {
        if self.tick_rate == 0 {
            return 0;
        }
        (ms * self.tick_rate).div_ceil(1000)
    }

    /// Inputs must be sorted for the scheduled-tick guarantee to hold. Callers that
    /// build a script by hand go through this rather than trusting their own order.
    pub fn sort_inputs(&mut self) {
        self.input_script.sort_by_key(|e| (e.tick, e.entity_id));
    }

    pub fn hash_into(&self, h: &mut Hasher) {
        h.write_u32(self.tick_rate);
        h.write_u32(self.duration_ticks);
        h.write_i64(self.world.bounds_x.to_bits());
        h.write_i64(self.world.bounds_y.to_bits());
        h.write_i64(self.world.friction.to_bits());
        h.write_i64(self.world.gravity.to_bits());
        for e in &self.entities {
            h.write_u16(e.id);
            h.write_u8(e.kind.tag());
            h.write_i64(e.start_x.to_bits());
            h.write_i64(e.start_y.to_bits());
            h.write_i64(e.max_speed.to_bits());
            h.write_i64(e.accel.to_bits());
            h.write_i64(e.radius.to_bits());
        }
        for i in &self.input_script {
            h.write_u32(i.tick);
            h.write_u16(i.entity_id);
            match i.action {
                InputAction::Move { dx, dy } => {
                    h.write_u8(0);
                    h.write_i64(dx.to_bits());
                    h.write_i64(dy.to_bits());
                }
                InputAction::Fire { dir_x, dir_y } => {
                    h.write_u8(1);
                    h.write_i64(dir_x.to_bits());
                    h.write_i64(dir_y.to_bits());
                }
                InputAction::Stop => h.write_u8(2),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scenario(tick_rate: u32) -> Scenario {
        Scenario {
            tick_rate,
            duration_ticks: 100,
            world: WorldConfig::default(),
            entities: vec![],
            input_script: vec![],
        }
    }

    #[test]
    fn tick_interval_follows_the_rate() {
        assert_eq!(scenario(64).tick_interval_ms(), ratio(1000, 64));
        assert_eq!(scenario(128).tick_interval_ms(), ratio(1000, 128));
        assert_eq!(scenario(20).tick_interval_ms(), from_int(50));
    }

    #[test]
    fn zero_tick_rate_does_not_divide_by_zero() {
        assert_eq!(scenario(0).tick_interval_ms(), Fx::ZERO);
        assert_eq!(scenario(0).ticks_for_ms(100), 0);
    }

    #[test]
    fn ticks_for_ms_rounds_up() {
        // at 64 Hz a tick is 15.625 ms, so 100 ms spans 7 ticks once rounded up
        assert_eq!(scenario(64).ticks_for_ms(100), 7);
        assert_eq!(scenario(128).ticks_for_ms(100), 13);
        assert_eq!(scenario(64).ticks_for_ms(0), 0);
    }

    #[test]
    fn sort_inputs_orders_by_tick_then_entity() {
        let mut s = scenario(64);
        s.input_script = vec![
            InputEvent {
                tick: 5,
                entity_id: 2,
                action: InputAction::Stop,
            },
            InputEvent {
                tick: 1,
                entity_id: 9,
                action: InputAction::Stop,
            },
            InputEvent {
                tick: 5,
                entity_id: 1,
                action: InputAction::Stop,
            },
        ];
        s.sort_inputs();
        let order: Vec<(u32, u16)> = s
            .input_script
            .iter()
            .map(|e| (e.tick, e.entity_id))
            .collect();
        assert_eq!(order, vec![(1, 9), (5, 1), (5, 2)]);
    }

    #[test]
    fn hash_distinguishes_tick_rate() {
        let mut a = Hasher::new();
        scenario(64).hash_into(&mut a);
        let mut b = Hasher::new();
        scenario(128).hash_into(&mut b);
        assert_ne!(a.finish(), b.finish());
    }

    #[test]
    fn hash_distinguishes_input_action() {
        let mut s1 = scenario(64);
        s1.input_script = vec![InputEvent {
            tick: 1,
            entity_id: 0,
            action: InputAction::Move {
                dx: from_int(1),
                dy: Fx::ZERO,
            },
        }];
        let mut s2 = scenario(64);
        s2.input_script = vec![InputEvent {
            tick: 1,
            entity_id: 0,
            action: InputAction::Stop,
        }];

        let mut a = Hasher::new();
        s1.hash_into(&mut a);
        let mut b = Hasher::new();
        s2.hash_into(&mut b);
        assert_ne!(a.finish(), b.finish());
    }
}
