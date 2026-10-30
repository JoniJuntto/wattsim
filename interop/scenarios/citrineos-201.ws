wattsim 1

csms "ws://localhost:8081"

station "WS-201-1" {
  version 2.0.1
  vendor "wattsim"
  model "interop-201"
  serial "WS-201-1"
  log "interop: wattsim 2.0.1 vs CitrineOS v2.1.0 on port 8081 (security profile 0); AA201001 ISO14443 pre-registered by citrineos-init (interop/README.md)"
  boot
  expect BootNotification {status: "Accepted"} within 10s
  ev plug evse 1 { battery 60kWh soc 20% phases 3 maxCurrent 32A }
  expect StatusNotification {connectorStatus: "Occupied"} within 5s
  authorize "AA201001"
  expect Authorize {idTokenInfo: {status: "Accepted"}} within 5s
  ev ready evse 1
  start evse 1 tag "AA201001"
  expect TransactionEvent {eventType: "Started"} within 5s
  wait 2min
  expect TransactionEvent {eventType: "Updated"} within 70s
  stop evse 1
  expect TransactionEvent {eventType: "Ended"} within 5s
  ev unplug evse 1
  expect StatusNotification {connectorStatus: "Available"} within 5s
}
