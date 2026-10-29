wattsim 1

station "CP-1" {
  version 1.6
  boot
  frobnicate
  choose {
    60%: {
      wait 1s
    }
    30%: {
      wait 2s
    }
  }
