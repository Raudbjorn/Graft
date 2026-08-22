# Vendored breadth grammars

`tree-sitter-luau.wasm` is the precompiled grammar from
[`tree-sitter-luau` 1.2.0](https://github.com/tree-sitter-grammars/tree-sitter-luau),
distributed under the adjacent MIT license.

SHA-256: `f1647052518f2bdfae8e8c0b033ffdeca1193d69d11c78ba20f84c8374fd0fe3`

The artifact is vendored because `tree-sitter-wasm` does not include Luau and
the grammar's npm package installs native dependencies that Graft does not use.

`tree-sitter-al.wasm` has no published grammar anywhere else — `tree-sitter-al`
is a new grammar built specifically to add AL (Business Central) support here
(see its own repo, submitted alongside this change). `requireWasm` in
`../generic.ts` checks this directory before falling back to the npm bundle.

## Rebuilding `tree-sitter-al.wasm`

From a checkout of `tree-sitter-al`:

```bash
npm install
npm run generate
npx tree-sitter build --wasm -o al.wasm
```

Then copy the result to `src/graph/grammars/tree-sitter-al.wasm` (this
directory) — filename matters, `requireWasm` looks it up as
`tree-sitter-${wasm}.wasm` for the `wasm: "al"` row in `GENERIC_LANGS`
(`../generic.ts`).

`tree-sitter build --wasm` downloads its own WASI SDK on first use (no
Emscripten or Docker needed) and needs a C compiler on `PATH` (`CC`/`CXX`
env vars if it isn't the default one) to build the grammar's native
`parser.c` first via `tree-sitter generate`.
