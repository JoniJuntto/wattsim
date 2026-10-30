wattsim 1

csms "ws://localhost:8180/steve/websocket/CentralSystemService"

station "WS-16-1" {
  version 1.6
  vendor "wattsim"
  model "interop-16"
  serial "WS-16-1"
  meterInterval 10s
  log "interop chaos: steve-16 with a 15s network drop 30s in; MeterValues queued offline must reach SteVe after reconnect"
  boot
  expect BootNotification {status: "Accepted"} within 10s
  at +30s {
    net drop 15s
  }
  ev plug evse 1 { battery 60kWh soc 20% phases 3 maxCurrent 32A }
  expect StatusNotification {status: "Preparing"} within 5s
  authorize "TAG-16-1"
  expect Authorize {idTagInfo: {status: "Accepted"}} within 5s
  ev ready evse 1
  start evse 1 tag "TAG-16-1"
  expect StartTransaction {idTagInfo: {status: "Accepted"}} within 5s
  expect StatusNotification {status: "Charging"} within 5s
  wait 2min
  expect MeterValues {connectorId: 1} within 15s
  stop evse 1
  expect StopTransaction within 5s
  ev unplug evse 1
  expect StatusNotification {status: "Available"} within 5s
}
