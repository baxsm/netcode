# netcode

Finds the netcode tuning parameters a multiplayer game should ship, by searching the configuration space against a deterministic simulation and scoring each result on responsiveness and smoothness.

## Setup

Requires Node 24+ and the Rust toolchain with the `wasm32-unknown-unknown` target.

```
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
npm install
npm run build:wasm
```

## Tests

```
npm test
```

Runs the typechecker, the Rust core suite, the Node determinism suite, and the cross-engine
suite in Chromium and Firefox.

The simulation core uses fixed-point arithmetic so a given seed produces bit-identical results
in every engine. `npm run test:e2e` is what enforces that: the same seed must produce the same
state hash in Chromium, Firefox and Node, checked against hashes recorded from the native Rust
build.
