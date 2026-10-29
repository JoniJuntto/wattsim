wattsim 1

csms "ws://localhost:9000/ocpp"

proc charge {
  ev plug evse 1
  authorize "TAG-1"
  start evse 1
  wait 2min
  stop evse 1
  ev unplug evse 1
}

station "CP-CHAOS" {
  version 1.6
  meterInterval 10s
  chaos drop out MeterValues nth 3
  chaos delay 2s in every 2
  boot
  at +30s {
    net drop 10s
  }
  call charge
  expect StopTransaction within 10s
}
