wattsim 1

// A station that is slow to come up and then barely talks. Every BootNotification (the first one and each retry
// after a Pending or Rejected answer) leaves 20 s after the station decided to boot, and once accepted the station
// keeps its own one-hour heartbeat whatever interval the CSMS sets. Whether a boot is Pending is the CSMS's call;
// pair this profile with a CSMS that answers Pending to see the retries arrive late as well.
quirk "slow-boot" {
  chaos delay 20s out BootNotification
  heartbeat 1h
}
