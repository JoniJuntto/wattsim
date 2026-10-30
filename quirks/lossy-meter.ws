wattsim 1

// A meter link that loses samples: every third MeterValues the station sends never reaches the CSMS. The station
// still waits for the answer, so each lost request also holds the queue until the request timeout (30 s). OCPP 2.x
// stations report transaction meter values in TransactionEvent, so on 2.x this hits MeterValues outside
// transactions only.
quirk "lossy-meter" {
  meterInterval 1min
  chaos drop out MeterValues every 3
}
