wattsim 1

csms "ws://localhost:9000/ocpp"

station "CP-1" {
  version 1.6
  heartbeat 1min
  meterInterval 30s
  boot
  expect BootNotification {status: "Accepted"} within 10s
  ev plug evse 1 { battery 60kWh soc 20% target 80% }
  expect StatusNotification {status: "Preparing"} within 5s
  authorize "TAG-1"
  expect Authorize {idTagInfo: {status: "Accepted"}} within 5s
  start evse 1 tag "TAG-1"
  expect StartTransaction within 5s
  expect StatusNotification {status: "Charging"} within 5s
  wait 30min
  expect MeterValues {connectorId: 1} within 30s
  stop evse 1
  expect StopTransaction within 5s
  ev unplug evse 1
  expect StatusNotification {status: "Available"} within 5s
}
