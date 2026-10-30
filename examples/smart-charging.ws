wattsim 1

csms "ws://localhost:9000/ocpp"

station "CP-SMART" {
  version 2.0.1
  evses 1
  connectors 1
  meterInterval 1min
  boot
  expect BootNotification {status: "Accepted"} within 10s
  ev plug evse 1 { battery 80kWh soc 25% phases 3 maxCurrent 32A target 90% }
  authorize "TAG-SMART"
  start evse 1 tag "TAG-SMART"
  expect TransactionEvent {eventType: "Started"} within 5s
  wait 2min
  log "A SetChargingProfile comes from the CSMS, not the station: the station applies the limit and reports it in the next Updated event"
  expect TransactionEvent {eventType: "Updated"} within 3min
  wait 30min
  stop evse 1
  expect TransactionEvent {eventType: "Ended"} within 5s
  ev unplug evse 1
}
