wattsim 1 // header

// shared profiles
import "lib/common.ws"
import "other.ws" // trailing

csms "ws://localhost:9000/ocpp"
let hb = 30s

// a local quirk
quirk "local" {
  // configuration
  heartbeat hb
  vendor "Example"
  meterInterval 10s
  chaos drop out MeterValues every 3 // lossy
  on Reset always {
    reply {status: "Rejected"}
  }
  clock skew -2s
  clock drift 50 ppm
  log "local quirk applied"
  use quirk "other"
  use plugin "./plugin.ts"
  // end of quirk
}

quirk "empty" {
  // nothing yet
}

proc p {
  use quirk "local"
}

station "CP-1" {
  version 1.6
  use quirk "local" // first
  boot
}
