#!/usr/bin/env bash
# Entrypoint of the `everest` compose service (profile `everest`): points EVerest's SIL (software-in-the-loop)
# charge point at wattsim's CSMS, then runs the EVerest manager in the foreground.
#
#   EVEREST_OCPP_VERSION  1.6 (OCPP module, config-sil-ocpp.yaml), or 2.0.1 / 2.1 (OCPP201 module, which speaks both,
#                         config-sil-ocpp201.yaml; InternalCtrlr.SupportedOcppVersions is narrowed to the one asked for)
#   WATTSIM_CSMS          host:port of wattsim's CSMS as seen from the container, no scheme, no path
#   EVEREST_STATION_ID    charge point identity; EVerest appends it to the CSMS URL as the last path segment
#   EVEREST_SIL_RESET_METER  true: keep YetiSimulator's default of zeroing the simulated energy register on every
#                         plug-in. Default false here, so Energy.Active.Import.Register is monotonic like a real meter;
#                         with true, a session that starts right after plug-in can report Transaction.Begin from the
#                         previous session and then values from the zeroed register (interop/README.md, "Findings").
#
# Everything is patched inside the container's own filesystem, so a recreated container starts from the image's
# defaults again (and with an empty OCPP database).
set -euo pipefail

VERSION="${EVEREST_OCPP_VERSION:-1.6}"
CSMS="${WATTSIM_CSMS:-host.docker.internal:19210}"
ID="${EVEREST_STATION_ID:-EVEREST-${VERSION//./}}"
SHARE=/ext/dist/share/everest/modules
export LD_LIBRARY_PATH=/ext/dist/lib:${LD_LIBRARY_PATH:-}
export PATH=/ext/dist/bin:$PATH

patch_json() { # file jq-filter [jq args...]
  local file=$1 filter=$2
  shift 2
  jq "$@" "$filter" "$file" >"$file.tmp" && mv "$file.tmp" "$file"
}

case "$VERSION" in
  1.6)
    # libocpp 1.6 builds the URL as ws://<CentralSystemURI><ChargePointId> for security profile 0 (no auth).
    patch_json "$SHARE/OCPP/config-docker.json" \
      '.Internal.ChargePointId = $id | .Internal.ChargeBoxSerialNumber = $id
       | .Internal.CentralSystemURI = ($csms + "/") | .Security.SecurityProfile = 0' \
      --arg id "$ID" --arg csms "$CSMS"
    jq -c '{Internal: (.Internal | {ChargePointId, CentralSystemURI}), Security: .Security.SecurityProfile}' \
      "$SHARE/OCPP/config-docker.json"
    CONF=/ext/source/config/config-sil-ocpp.yaml
    ;;
  2.0.1 | 2.1)
    # libocpp 2.x connects to <ocppCsmsUrl>/<SecurityCtrlr.Identity>. Security profile 1 (the lowest 2.0.1 defines)
    # adds an HTTP Basic header; wattsim's CSMS ignores it unless started with basicAuth.
    CC="$SHARE/OCPP201/component_config/standardized"
    patch_json "$CC/InternalCtrlr.json" \
      '.properties.NetworkConnectionProfiles.attributes[0].value |=
         (fromjson | map(.connectionData.ocppCsmsUrl = ("ws://" + $csms) | .connectionData.securityProfile = 1) | tojson)
       | .properties.ChargePointId.attributes[0].value = $id
       | .properties.SupportedOcppVersions.attributes[0].value = ("ocpp" + $v)' \
      --arg id "$ID" --arg csms "$CSMS" --arg v "$VERSION"
    patch_json "$CC/SecurityCtrlr.json" '.properties.SecurityCtrlrIdentity.attributes[0].value = $id' --arg id "$ID"
    rm -f "$SHARE/OCPP201/device_model_storage.db"
    jq -r '.properties.NetworkConnectionProfiles.attributes[0].value' "$CC/InternalCtrlr.json"
    CONF=/ext/source/config/config-sil-ocpp201.yaml
    ;;
  *)
    echo "EVEREST_OCPP_VERSION must be 1.6, 2.0.1 or 2.1, got '$VERSION'" >&2
    exit 64
    ;;
esac

# Copy of the SIL config with the simulated meter's reset switch set (PyYAML ships in the image).
RESET="${EVEREST_SIL_RESET_METER:-false}"
python3 - "$CONF" /tmp/wattsim-interop.yaml "$RESET" <<'PY'
import sys, yaml
src, dst, reset = sys.argv[1], sys.argv[2], sys.argv[3] == "true"
cfg = yaml.safe_load(open(src))
for mod in cfg["active_modules"].values():
    if mod.get("module") == "YetiSimulator":
        mod.setdefault("config_module", {})["reset_powermeter_on_session_start"] = reset
yaml.safe_dump(cfg, open(dst, "w"), sort_keys=False)
PY

echo "wattsim-interop: EVerest $EVEREST_VERSION, OCPP $VERSION, identity $ID -> ws://$CSMS/$ID," \
  "config $CONF (YetiSimulator reset_powermeter_on_session_start=$RESET)"
exec manager --prefix /ext/dist --conf /tmp/wattsim-interop.yaml
