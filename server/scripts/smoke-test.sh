#!/bin/bash
# Non-destructive post-deploy smoke test. Only checks safe, unauthenticated behavior — never
# creates, deletes, or alters a record, and never attempts real authentication against a
# privileged production user (that's a manual step, not something this script should try to
# automate with real credentials). See docs/PROCESSPASS_PRODUCTION_ASSURANCE.md for the full
# deployment checklist this is one step of.
#
# Usage: scripts/smoke-test.sh https://compliance.808techserviceshi.cc
set -euo pipefail

BASE_URL="${1:?Usage: $0 <base-url>, e.g. https://compliance.808techserviceshi.cc}"
FAILED=0

check() {
  # $3 is one or more space-separated acceptable codes, e.g. "200" or "200 429".
  local description="$1" path="$2" expected="$3" method="${4:-GET}"
  local actual
  actual=$(curl -s -o /dev/null -w '%{http_code}' -X "$method" "${BASE_URL}${path}")
  if [[ " $expected " == *" $actual "* ]]; then
    echo "OK    $description ($method $path -> $actual)"
  else
    echo "FAIL  $description ($method $path -> $actual, expected one of: $expected)"
    FAILED=1
  fi
}

check "health endpoint reports ok"                 "/api/health"                       200
check "ProcessPass kiosk is reachable"              "/processpass"                      200
check "login page is reachable"                     "/login"                            200
check "unauthenticated owner dashboard is denied"   "/dashboard/owner"                  401
check "unauthenticated accounting dashboard denied" "/dashboard/accounting"             401
check "unauthenticated passkeys page is denied"     "/dashboard/passkeys"               401
check "unauthenticated receipts API is denied"      "/api/receipts"                     401
check "demo-identity route is off in production"    "/api/processpass/identify"         404 POST
check "webauthn login/options is reachable (public)" "/api/webauthn/login/options"      "200 429" POST
check "nonexistent route 404s"                      "/this-route-does-not-exist"        404

if [ "$FAILED" -ne 0 ]; then
  echo
  echo "One or more checks failed — investigate before considering this deploy verified."
  exit 1
fi
echo
echo "All smoke-test checks passed."
