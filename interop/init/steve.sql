-- Pre-register the interop charge box and idTag for SteVe 3.14.1 (schema: Flyway B1_0_5 + later).
-- SteVe rejects websocket upgrades from chargeBoxIds that are not in charge_box.
INSERT IGNORE INTO charge_box (charge_box_id, registration_status, description, insert_connector_status_after_transaction_msg)
VALUES ('WS-16-1', 'Accepted', 'wattsim interop station (interop/scenarios/steve-16.ws)', 1);

INSERT IGNORE INTO ocpp_tag (id_tag, max_active_transaction_count, note)
VALUES ('TAG-16-1', 1, 'wattsim interop tag');
