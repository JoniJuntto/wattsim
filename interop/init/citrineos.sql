-- Pre-register the interop station and idToken for CitrineOS v2.1.0 (default tenant id 1, created by migration
-- 20250430110000-create-default-tenant). Column names are the Sequelize/Drizzle camelCase names, hence the quotes.
INSERT INTO "Authorizations" ("idToken", "idTokenType", "status", "tenantId", "isPrepaid", "createdAt", "updatedAt")
VALUES ('TAG-201-1', 'ISO14443', 'Accepted', 1, false, now(), now())
ON CONFLICT DO NOTHING;

-- Station row. Port 8081 (allowUnknownChargingStations=true) creates this on first connect anyway; having it
-- up front means the station is also "known" to the profile-1 listener on 8082 once a password is set.
INSERT INTO "ChargingStations" ("ocppConnectionName", "tenantId", "chargePointVendor", "chargePointModel", "createdAt", "updatedAt")
VALUES ('WS-201-1', 1, 'wattsim', 'interop-201', now(), now())
ON CONFLICT ("ocppConnectionName", "tenantId") DO NOTHING;
