wattsim 1

// A station that accepts a remote stop and then carries on charging: the CSMS gets Accepted and no transaction
// ends. The scripted answer has no side effects, so the transaction stays open until something local stops it.
quirk "ignores-remote-stop" {
  // OCPP 1.6
  on RemoteStopTransaction always {
    reply {status: "Accepted"}
  }
  // OCPP 2.0.1 and 2.1
  on RequestStopTransaction always {
    reply {status: "Accepted"}
  }
}
