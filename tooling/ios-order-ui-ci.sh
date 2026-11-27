#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# -ne 2 || ! ${1:-} =~ ^[[:xdigit:]]{8}(-[[:xdigit:]]{4}){3}-[[:xdigit:]]{12}$ || -z ${2:-} ]]; then
  printf 'Usage: %s SIMULATOR_UDID EVIDENCE_DIR\n' "$0" >&2
  exit 2
fi
if [[ $(uname -s) != Darwin || $(uname -m) != arm64 ]]; then
  printf 'The order UI runner requires an Apple silicon macOS host.\n' >&2
  exit 2
fi

simulator=$1
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
mkdir -p -- "$2"
evidence=$(cd "$2" && pwd -P)
build_log="$evidence/ui-build.log"
test_log="$evidence/ui-test.log"
result_bundle="$evidence/order-ui.xcresult"
summary="$evidence/ui-test-summary.json"
receipt="$evidence/ui-runner.txt"
for output in "$build_log" "$test_log" "$result_bundle" "$summary" "$receipt"; do
  if [[ -e $output || -L $output ]]; then
    printf 'Order UI evidence already exists at %s\n' "$output" >&2
    exit 2
  fi
done

scratch=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/crustcaper-ios-order-ui.XXXXXXXX")
phase=preflight
cleanup() {
  local status=$? removal=removed
  if ! rm -rf -- "$scratch"; then
    removal=failed
    if [[ $status -eq 0 ]]; then
      status=1
    fi
  fi
  printf 'simulator=%s\nphase=%s\nexit_code=%s\nscratch_cleanup=%s\n' \
    "$simulator" "$phase" "$status" "$removal" > "$receipt"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

xcrun simctl get_app_container "$simulator" com.crustcaper.mobile.local app >/dev/null
scheme=CrustCaperOrderUITests
project="$scratch/$scheme.xcodeproj"
derived_data="$scratch/DerivedData"
destination="platform=iOS Simulator,id=$simulator"
cp "$script_dir/ios-order-checkout.swift" "$scratch/ios-order-checkout.swift"

phase=build
{
  ruby "$script_dir/ios-order-ui-project.rb" "$project" &&
    xcodebuild -project "$project" -scheme "$scheme" -configuration Release \
      -sdk iphonesimulator -destination "$destination" -derivedDataPath "$derived_data" \
      -jobs 2 -parallel-testing-enabled NO ARCHS=arm64 ONLY_ACTIVE_ARCH=YES build-for-testing
} > "$build_log" 2>&1 || {
  status=$?
  tail -n 100 "$build_log" >&2 || true
  exit "$status"
}

shopt -s nullglob
manifests=("$derived_data"/Build/Products/*.xctestrun)
if [[ ${#manifests[@]} -ne 1 || ! -s ${manifests[0]} ]]; then
  printf 'Xcode must generate one nonempty XCTest run manifest.\n' >&2
  exit 1
fi

phase=test
xcodebuild test-without-building -xctestrun "${manifests[0]}" -destination "$destination" \
  -parallel-testing-enabled NO -test-timeouts-enabled YES \
  -default-test-execution-time-allowance 180 -maximum-test-execution-time-allowance 240 \
  -resultBundlePath "$result_bundle" > "$test_log" 2>&1 || {
    status=$?
    tail -n 100 "$test_log" >&2 || true
    exit "$status"
  }
if [[ ! -d $result_bundle ]]; then
  printf 'Xcode did not write an XCTest result bundle.\n' >&2
  exit 1
fi

phase=verify
xcrun xcresulttool get test-results summary --path "$result_bundle" > "$summary"
node - "$summary" <<'NODE'
const { readFileSync } = require('node:fs');
const { failedTests, passedTests, result, skippedTests, totalTestCount } =
  JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (result !== 'Passed' || !Number.isInteger(totalTestCount) || totalTestCount < 1 ||
    passedTests !== totalTestCount || failedTests !== 0 || skippedTests !== 0) {
  throw new Error('Xcode did not report a completed passing checkout test.');
}
NODE

phase=passed
