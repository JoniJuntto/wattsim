wattsim 1

import "lib/slow.ws"

csms "ws://localhost:9000/ocpp"

quirk "local" {
  chaos drop out MeterValues nth 3
}

proc charge {
  ev plug evse 1 { battery 60kWh soc 20% }
  start evse 1 tag "TAG-1"
  wait 10min
}

station "CP-1" {
  version 1.6
  use quirk "slow"
  use quirk "local"
  boot
  expect result BootNotification {status: "Accepted"} within 10s
  call charge
  send DataTransfer {vendorId: "wattsim"}
}

station "CP-2" {
  version 2.0.1
  boot
  expect TransactionEvent within 5s
}
