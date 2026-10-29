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
  log "SetChargingProfile comes from the CSMS; the station only applies the limit and reports it"
  expect SetChargingProfile {evseId: 1} within 10min
  expect TransactionEvent {eventType: "Updated"} within 5min
  wait 30min
  stop evse 1
  expect TransactionEvent {eventType: "Ended"} within 5s
  ev unplug evse 1
}
