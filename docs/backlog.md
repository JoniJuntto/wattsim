# Backlog

Known gaps found while building milestone 1. Not scheduled; ordered roughly by how often a scenario author would hit them.

## DSL

- Variables are only usable inside string interpolation and as JSON refs. `wait pause`, `repeat n`, `start evse i`, `csms url` are syntax errors.
- `expect` cannot select direction or distinguish a CALL from its CALLRESULT; it relies on payload shape.
- `send` requires a payload (`send Heartbeat {}`). No way to script a reply to a CSMS CALL (`on SetChargingProfile { ... }`).
- `choose` weights are integers only. No duration distributions (`normal(45min, 10min)` from DESIGN.md).
- `net` has only `drop`. `at` takes only positive relative offsets. No `clock set` or `clock freeze`. `clock drift` rejects negatives. A chaos rule takes one trigger only.
- Station template names are not checked for a `{var}` reference. `fmt` drops comments. `60s` canonicalizes to `1min`.

## Protocol

- Security profiles 2 and 3 (TLS, client certificates) and the certificate lifecycle messages.

## Smart charging simplifications

- A charging schedule is reduced to the limit of its first period: `stackLevel`, purpose precedence, `validFrom` / `validTo`, `duration` and every schedule period beyond the first are ignored.
- A `ChargingStationMaxProfile` / `ChargePointMaxProfile` sent for evseId 0 is applied per EVSE, so the station total is N x limit rather than a shared cap.
- `ClearChargingProfile` ignores its criteria (id, stackLevel, purpose) and returns `Accepted` even when nothing was cleared (spec: `Unknown`).
- All inbound schema failures collapse to FormationViolation/FormatViolation; 1.6 PropertyConstraintViolation and TypeConstraintViolation are not distinguished.
