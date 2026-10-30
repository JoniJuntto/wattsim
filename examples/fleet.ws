// A fleet where most stations idle and some charge, with session lengths around 45 minutes.
wattsim 1

csms "ws://localhost:9000/ocpp"
let tag = "FLEET"
let size = 200
let session = normal(45min, 10min)

station "CP-{i}" for i in 1..size {
  version 2.0.1
  clock speed 60
  heartbeat 5min
  meterInterval 1min
  boot
  choose {
    70%: {
      wait session
    }
    30%: {
      ev plug evse 1 { battery 75kWh soc 15% target 80% }
      authorize "{tag}-{i}"
      start evse 1 tag "{tag}-{i}"
      wait session
      stop evse 1
      ev unplug evse 1
    }
  }
}
