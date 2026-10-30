wattsim 1

// A station that ignores the heartbeat interval the CSMS returns in BootNotification and sends a Heartbeat every
// 15 s. A configured interval wins over the CSMS's, which is exactly the behaviour of such a station.
quirk "chatty-heartbeat" {
  heartbeat 15s
}
