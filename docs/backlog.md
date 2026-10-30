# Backlog

Known gaps found while building milestone 1. Not scheduled; ordered roughly by how often a scenario author would hit them.

## DSL

- `on <Action> { reply ... }` parses and formats but fails the station when run: the core has no hook to answer an inbound CALL from a scenario.
- A chaos rule takes one trigger only.
- Station template names are not checked for a `{var}` reference.

## Protocol

- Security profiles 2 and 3 (TLS, client certificates) and the certificate lifecycle messages.

## Smart charging simplifications

- A charging schedule is reduced to the limit of its first period: `stackLevel`, purpose precedence, `validFrom` / `validTo`, `duration` and every schedule period beyond the first are ignored.
- A `ChargingStationMaxProfile` / `ChargePointMaxProfile` sent for evseId 0 is applied per EVSE, so the station total is N x limit rather than a shared cap.
- `ClearChargingProfile` ignores its criteria (id, stackLevel, purpose) and returns `Accepted` even when nothing was cleared (spec: `Unknown`).
