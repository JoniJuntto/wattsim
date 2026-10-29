wattsim 1

csms "ws://localhost:9000/ocpp"
let tag = "FLEET-TAG"

station "CP-{i}" for i in 1..100 {
  version 2.0.1
  clock speed 60
  boot
  choose {
    70%: {
      wait 10min
    }
    30%: {
      ev plug evse 1 { soc 20% target 80% }
      authorize "{tag}-{i}"
      start evse 1
      wait 30min
      stop evse 1
      ev unplug evse 1
    }
  }
}
