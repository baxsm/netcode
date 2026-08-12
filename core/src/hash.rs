//! FNV-1a 64-bit over raw bytes.
//!
//! Hand-rolled rather than `DefaultHasher`, whose output Rust explicitly does not
//! guarantee to be stable across versions. This hash is the project's correctness
//! mechanism, so its definition has to be pinned here where it can be read.

const OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
const PRIME: u64 = 0x0000_0100_0000_01b3;

#[derive(Clone, Copy)]
pub struct Hasher {
    state: u64,
}

impl Default for Hasher {
    fn default() -> Self {
        Self::new()
    }
}

impl Hasher {
    #[inline]
    pub fn new() -> Self {
        Self {
            state: OFFSET_BASIS,
        }
    }

    #[inline]
    pub fn write_u8(&mut self, b: u8) {
        self.state ^= b as u64;
        self.state = self.state.wrapping_mul(PRIME);
    }

    #[inline]
    pub fn write_u64(&mut self, v: u64) {
        for b in v.to_le_bytes() {
            self.write_u8(b);
        }
    }

    #[inline]
    pub fn write_i64(&mut self, v: i64) {
        self.write_u64(v as u64);
    }

    #[inline]
    pub fn write_u32(&mut self, v: u32) {
        for b in v.to_le_bytes() {
            self.write_u8(b);
        }
    }

    #[inline]
    pub fn write_u16(&mut self, v: u16) {
        for b in v.to_le_bytes() {
            self.write_u8(b);
        }
    }

    #[inline]
    pub fn finish(self) -> u64 {
        self.state
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_published_fnv1a_vectors() {
        // reference vectors from the FNV specification
        let mut h = Hasher::new();
        for b in b"" {
            h.write_u8(*b);
        }
        assert_eq!(h.finish(), 0xcbf29ce484222325);

        let mut h = Hasher::new();
        for b in b"a" {
            h.write_u8(*b);
        }
        assert_eq!(h.finish(), 0xaf63dc4c8601ec8c);

        let mut h = Hasher::new();
        for b in b"foobar" {
            h.write_u8(*b);
        }
        assert_eq!(h.finish(), 0x85944171f73967e8);
    }

    #[test]
    fn distinguishes_field_order() {
        let mut a = Hasher::new();
        a.write_u32(1);
        a.write_u32(2);

        let mut b = Hasher::new();
        b.write_u32(2);
        b.write_u32(1);

        assert_ne!(a.finish(), b.finish());
    }

    #[test]
    fn single_bit_change_changes_hash() {
        let mut a = Hasher::new();
        a.write_i64(0);
        let mut b = Hasher::new();
        b.write_i64(1);
        assert_ne!(a.finish(), b.finish());
    }
}
