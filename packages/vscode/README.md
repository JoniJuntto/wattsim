# wattsim scenarios for VS Code

Language support for [wattsim](https://github.com/JoniJuntto/wattsim) scenario files (`.ws`):

- syntax highlighting, generated from the scenario parser's own keyword list;
- diagnostics as you type: parse errors, unknown quirks, `use quirk` cycles, unreadable imports and missing plugins;
- formatting (`Format Document`) with the canonical `wattsim fmt` layout;
- hover documentation for keywords (from the DSL reference) and OCPP actions (who initiates each, per OCPP version);
- completion for keywords, OCPP actions, quirk names and procedure names;
- go to definition for `call`, `use quirk`, `use plugin` and `import`;
- snippets for stations, procs, quirks and common statements.

The language server runs under [Bun](https://bun.sh) when `bun` is on your PATH (or in `~/.bun/bin`), and otherwise
under the Node runtime built into VS Code. Set `wattsim.server.runtime` to `bun` or `node` to choose.
