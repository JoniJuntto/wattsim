wattsim 1

csms "ws://localhost:9000/ocpp"
let tag = "TAG-1"
let pause = 5s
let evseId = 1
let limit = 32.5

proc idle {
  log "idle for {pause}"
  wait 5s
}

station "CP-{i}" for i in 1..3 {
  version 2.0.1
  evses 2
  connectors 2
  vendor "wattsim"
  model "Sim-{i}"
  serial "SN-{i}"
  auth "user" "secret"
  heartbeat 30s
  meterInterval 10s
  connect
  boot
  heartbeat
  barrier ready
  wait until ready
  status evse 1 Faulted
  send DataTransfer {vendorId: "wattsim", data: [1, 2.5, true, false, null, evseId, "{tag}"], nested: {}}
  expect DataTransfer {status: "Accepted"} within 2s
  expect Heartbeat
  expect BootNotification within 10s
  expect MeterValues {evseId: 1}
  ev plug evse 1 { battery 60kWh soc 20% phases 3 maxCurrent 32A target 80% name "ev-{i}" }
  ev ready evse 1
  ev suspend evse 1
  ev resume evse 1
  authorize "{tag}"
  start evse 1 tag "{tag}"
  start evse 2
  repeat 3 {
    call idle
  }
  at +30s {
    net drop 10s
  }
  choose {
    50%: {
      wait 1min
    }
    50%: {
      wait 2min
    }
  }
  chaos drop
  chaos drop out MeterValues nth 3
  chaos delay 2s in every 2
  chaos duplicate out probability 10%
  chaos corrupt in once
  chaos wrongId
  chaos callError in StartTransaction
  chaos noResponse out BootNotification nth 1 once
  clock speed 60
  clock skew -2s
  clock skew 1500ms
  clock drift 50 ppm
  stop evse 1
  ev unplug evse 1
  disconnect
  fail "gave up"
}
