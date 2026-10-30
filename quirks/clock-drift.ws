wattsim 1

// A real-time clock that was set 90 s fast and gains another 2000 ppm (7.2 s per hour). Every timestamp the
// station sends drifts further from the CSMS's clock over a long session.
quirk "clock-drift" {
  clock skew 90s
  clock drift 2000 ppm
}
