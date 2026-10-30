# Open OCPP Trace Format - Notice

`trace-v1.schema.json` (the record schema, format v1.1) and everything under `fixtures/` (the conformance corpus:
one `trace.jsonl` and its `expected.json` consumer view per scenario, plus the corpus README) are published by the
Open OCPP Trace project, https://github.com/open-ocpp-trace/specification. They are redistributed here verbatim: no
file has been modified, and paths below this directory match the upstream repository (`schema/trace-v1.schema.json`
is stored here as `trace-v1.schema.json`).

## Licensing

The upstream repository licenses its machine-readable artifacts (the JSON Schema, the fixtures and the conformance
tests) under the Apache License 2.0; a copy is in `LICENSE`, copied verbatim from upstream. Upstream ships no
`NOTICE` file. The upstream specification prose (README, `docs/`) is CC-BY-4.0 and is not copied here.

## Provenance

- Repository: https://github.com/open-ocpp-trace/specification
- Commit: `c9c2499d821f6d5f7d5981da86b50d225c1d9ef8` (committed 2026-07-22, "feat: v1.1 schema, 15 conformance
  fixtures, and corpus self-check (#3)")
- Copied on: 2026-10-30
- Integrity: every file's git blob hash was checked against the upstream tree at that commit.
- Prose definition of v1.1 (field semantics, versioning rules): `docs/concepts/trace-format.md` in
  https://github.com/shiv3/ocpp-cp-simulator (Apache-2.0), referenced by the specification README until it moves.
