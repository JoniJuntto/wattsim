// Milestone 2 syntax, in canonical form.
wattsim 1 // header

// where to connect
csms url
let url = "ws://localhost:9000/ocpp"
let n = 2
let pause = 5min
let hb = 30s
let jitter = normal(45min, 10min)
let offset = -2s
let speed = 1.5
let cap = 60

proc idle {
  wait uniform(1s, 5s)
  // nothing after this
}

station "CP-{i}" for i in 1..n {
  version 2.1
  evses n
  heartbeat hb
  clock speed speed
  clock skew offset
  clock drift -50 ppm
  clock set "2026-03-29T01:59:50Z"
  clock freeze
  clock resume
  net delay 200ms for 10s
  net delay 50ms
  net drop pause
  boot // trailing
  send Heartbeat
  expect call Heartbeat within hb
  expect result BootNotification {status: "Accepted"} within 60s
  expect error Authorize NotImplemented within 2min
  expect error DataTransfer
  on SetChargingProfile {evseId: 1} always {
    reply {status: "Rejected"}
  }
  on Reset {
    error NotSupported "no resets here"
  }
  ev plug evse i { battery cap soc 20% }
  start evse i tag "T-{i}"
  repeat n {
    call idle
  }
  at +exp(30s) {
    stop evse i
  }
  wait jitter
  choose {
    // mostly idle
    33.3%: {
      wait 1min
    }
    66.7%: {
      wait 90s
    }
  }
  chaos drop out MeterValues nth n
  chaos delay pause in every 2
  chaos duplicate probability 0.5%
  log "done"
}

// end of file
