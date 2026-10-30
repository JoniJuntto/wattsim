wattsim 1

// A station whose StatusNotifications lag: each one leaves 10 s after the state change it reports. Requests queue
// behind it (OCPP-J allows one CALL in flight), so a StartTransaction right after plugging in waits as well.
quirk "late-status" {
  chaos delay 10s out StatusNotification
}
