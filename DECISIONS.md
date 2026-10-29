# Decisions

Append-only log. One entry per decision that a future reader would otherwise have to reverse-engineer.

## 2026-10-29 Project agreed

See DESIGN.md for the full agreement from the initial design session. Key calls: Apache-2.0, Bun, custom DSL over YAML, generated Zod from verbatim-vendored OCA schemas with generated code never committed, native Bun WebSockets in the OCPP hot path, local-first server with no auth.

## 2026-10-29 Hand-written recursive-descent parser for the DSL

Milestone 1 uses a hand-written lexer and parser rather than a grammar generator. The TextMate grammar for editor support will be derived when the VS Code extension is built; until then the syntax has one source of truth (the parser) and one test suite.
