// Interop: wattsim 2.0.1 station vs CitrineOS v2.1.0 (interop/docker-compose.yml).
// Port 8081 is security profile 0 (no auth) with allowUnknownChargingStations=true;
// TAG-201-1 (ISO14443, Accepted, tenant 1) is pre-registered by citrineos-init (interop/init/citrineos.sql).
// CitrineOS takes the station id from the last URL path segment: ws://host:8081/<stationId>.
wattsim 1

csms "ws://localhost:8081"

station "WS-201-1" {
  version 2.0.1
  vendor "wattsim"
  model "interop-201"
  serial "WS-201-1"
  boot
  expect BootNotification {status: "Accepted"} within 10s
  ev plug evse 1 { battery 60kWh soc 20% phases 3 maxCurrent 32A }
  expect StatusNotification {connectorStatus: "Occupied"} within 5s
  authorize "TAG-201-1"
  expect Authorize {idTokenInfo: {status: "Accepted"}} within 5s
  start evse 1 tag "TAG-201-1"
  expect TransactionEvent {eventType: "Started"} within 5s
  wait 2min
  expect TransactionEvent {eventType: "Updated"} within 70s
  stop evse 1
  expect TransactionEvent {eventType: "Ended"} within 5s
  ev unplug evse 1
  expect StatusNotification {connectorStatus: "Available"} within 5s
}
