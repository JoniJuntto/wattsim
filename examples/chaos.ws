wattsim 1

csms "ws://localhost:9000/ocpp"

proc charge {
  ev plug evse 1 { battery 60kWh soc 30% target 80% }
  authorize "TAG-CHAOS"
  start evse 1 tag "TAG-CHAOS"
  wait 10min
  stop evse 1
  ev unplug evse 1
}

station "CP-CHAOS" {
  version 1.6
  meterInterval 30s
  chaos drop out MeterValues nth 3
  chaos delay 2s in every 2
  boot
  at +3min {
    net drop 20s
  }
  at +7min {
    status evse 1 Faulted
    wait 30s
    status evse 1 Charging
  }
  call charge
  expect StopTransaction within 10s
  expect StatusNotification {status: "Available"} within 5s
}
