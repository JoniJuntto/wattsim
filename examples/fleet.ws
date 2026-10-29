wattsim 1

csms "ws://localhost:9000/ocpp"
let tag = "FLEET"

station "CP-{i}" for i in 1..200 {
  version 2.0.1
  clock speed 60
  heartbeat 5min
  meterInterval 1min
  boot
  choose {
    70%: {
      wait 45min
    }
    30%: {
      ev plug evse 1 { battery 75kWh soc 15% target 80% }
      authorize "{tag}-{i}"
      start evse 1 tag "{tag}-{i}"
      wait 45min
      stop evse 1
      ev unplug evse 1
    }
  }
}
