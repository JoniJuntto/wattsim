wattsim 1

// A bus and van depot: twenty 22 kW chargers on two sub-boards behind a 3x250 A connection, with the workshop HVAC,
// the offices and rooftop PV on the same main board. The reference controller shares what is left fairly; run it with
// `--controller none` to watch a sub-board breaker trip instead.
let arrival = uniform(0min, 20min)

site "Depot" {
  supply 3x400V 250A
  time "2026-06-15T07:00:00Z"
  tolerance seed 42
  transformer "T1" 400kVA uk 4% {
    fuse "F0" gG 250A {
      // The site meter a local DLM would read: Modbus TCP, unit 1.
      meter "M0" sdm630 port 1502 unit 1 {
        board "MDB" 250A {
          breaker "Q1" C 125A {
            cable "W1" 50mm2 Cu 30m C {
              board "SB1" 125A
            }
          }
          breaker "Q2" C 125A {
            cable "W2" 50mm2 Cu 30m C {
              board "SB2" 125A
            }
          }
          load "HVAC" profile "dlm-depot-hvac.csv" linear loop daily pf 0.9
          load "Office" shape office 30kW pf 0.95
          pv "Roof" 60kW sunrise 5h sunset 21h clouds 30% seed 7
        }
      }
    }
  }
  controller reference every 10s margin 5%
  expect no trip
  expect "F0" current <= 250A
  expect no violation overcurrent
}

proc charge {
  start evse 1
  wait 100min
  stop evse 1
  ev unplug evse 1
}

station "CP-{i}" for i in 1..9 {
  site "Depot" at "SB1" phases rotate breaker C 40A cable 10mm2 Cu 25m C
  version 1.6
  meterInterval 5min
  boot
  wait arrival
  ev plug evse 1 { battery 75kWh soc 25% target 90% }
  call charge
}

// A single-phase van: it draws on one site phase only.
station "CP-10" {
  site "Depot" at "SB1" phases rotate breaker C 40A cable 10mm2 Cu 25m C
  version 1.6
  meterInterval 5min
  boot
  wait arrival
  ev plug evse 1 { battery 40kWh soc 30% phases 1 }
  call charge
}

station "CP-{i}" for i in 11..19 {
  site "Depot" at "SB2" phases rotate breaker C 40A cable 10mm2 Cu 25m C
  version 2.0.1
  meterInterval 5min
  boot
  wait arrival
  ev plug evse 1 { battery 75kWh soc 25% target 90% }
  call charge
  expect "SB2" current <= 125A
}

station "CP-20" {
  site "Depot" at "SB2" phases rotate breaker C 40A cable 10mm2 Cu 25m C
  version 2.0.1
  meterInterval 5min
  boot
  wait arrival
  ev plug evse 1 { battery 40kWh soc 30% phases 1 }
  call charge
}
