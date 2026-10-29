wattsim 1

csms "ws://localhost:9000/ocpp"

station "CP-1" {
  version 1.6
  boot
  ev plug evse 1 { battery 60kWh soc 20% }
  authorize "TAG-1"
  start evse 1 tag "TAG-1"
  wait 5min
  stop evse 1
  ev unplug evse 1
  expect StatusNotification {status: "Available"} within 5s
}
