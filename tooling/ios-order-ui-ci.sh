#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# -lt 2 || $# -gt 3 || ! ${1:-} =~ ^[[:xdigit:]]{8}(-[[:xdigit:]]{4}){3}-[[:xdigit:]]{12}$ || -z ${2:-} ]] ||
   [[ $# -eq 3 && ${3:-} != probe ]]; then
  printf 'Usage: %s SIMULATOR_UDID EVIDENCE_DIR [probe]\n' "$0" >&2
  exit 2
fi
if [[ $(uname -s) != Darwin || $(uname -m) != arm64 ]]; then
  printf 'The order UI runner requires an Apple silicon macOS host.\n' >&2
  exit 2
fi

simulator=$1
mode=${3:-checkout}
receipt_smoke=${CRUSTCAPER_IOS_RECEIPT_SMOKE:-0}
if [[ "$receipt_smoke" != 0 && ( "$receipt_smoke" != 1 || "$mode" != checkout ) ]]; then
  printf 'Receipt sharing verification requires the connected checkout runner.\n' >&2
  exit 2
fi
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
mkdir -p -- "$2"
evidence=$(cd "$2" && pwd -P)
build_log="$evidence/ui-build.log"
test_log="$evidence/ui-test.log"
result_bundle="$evidence/order-ui.xcresult"
summary="$evidence/ui-test-summary.json"
receipt="$evidence/ui-runner.txt"
scheme_evidence="$evidence/CrustCaperOrderUITests.xcscheme"
fixture_log="$evidence/receipt-fixture.log"
for output in "$build_log" "$test_log" "$result_bundle" "$summary" "$receipt" "$scheme_evidence"; do
  if [[ -e $output || -L $output ]]; then
    printf 'Order UI evidence already exists at %s\n' "$output" >&2
    exit 2
  fi
done

scratch=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/crustcaper-ios-order-ui.XXXXXXXX")
phase=preflight
fixture_pid=''

stop_fixture() {
  local attempt
  if [[ -z "$fixture_pid" ]]; then return; fi
  if kill -0 "$fixture_pid" 2>/dev/null; then
    kill -TERM "$fixture_pid" 2>/dev/null || true
    for ((attempt = 0; attempt < 10; attempt++)); do
      kill -0 "$fixture_pid" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$fixture_pid" 2>/dev/null; then
      kill -KILL "$fixture_pid" 2>/dev/null || return 1
    fi
  fi
  wait "$fixture_pid" 2>/dev/null || true
}

cleanup() {
  local status=$? removal=removed
  if ! stop_fixture; then
    status=1
  fi
  if ! rm -rf -- "$scratch"; then
    removal=failed
    if [[ $status -eq 0 ]]; then
      status=1
    fi
  fi
  printf 'simulator=%s\nphase=%s\nexit_code=%s\nscratch_cleanup=%s\nmode=%s\n' \
    "$simulator" "$phase" "$status" "$removal" "$mode" > "$receipt"
  if [[ "$receipt_smoke" == 1 ]]; then printf 'receipt_sharing=1\n' >> "$receipt"; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ $mode == probe ]]; then
  test_source=ios-order-runner-probe.swift
else
  xcrun simctl get_app_container "$simulator" com.crustcaper.mobile.local app >/dev/null
  test_source=ios-order-checkout.swift
fi
scheme=CrustCaperOrderUITests
project="$scratch/$scheme.xcodeproj"
derived_data="$scratch/DerivedData"
destination="platform=iOS Simulator,id=$simulator,arch=arm64"
xcode_options=(-project "$project" -scheme "$scheme" -configuration Release -sdk iphonesimulator
  -destination "$destination" -derivedDataPath "$derived_data" -parallel-testing-enabled NO
  ARCHS=arm64 ONLY_ACTIVE_ARCH=YES)
default_allowance=180
maximum_allowance=240
if [[ "$receipt_smoke" == 1 ]]; then
  xcode_options+=(SWIFT_ACTIVE_COMPILATION_CONDITIONS=CRUSTCAPER_IOS_RECEIPT_SHARING)
  default_allowance=360
  maximum_allowance=420
fi
cp "$script_dir/$test_source" "$scratch/ios-order-checkout.swift"

phase=build
{
  ruby "$script_dir/ios-order-ui-project.rb" "$project" &&
    cp "$project/xcshareddata/xcschemes/$scheme.xcscheme" "$scheme_evidence" &&
    xcodebuild "${xcode_options[@]}" -jobs 2 build-for-testing
} > "$build_log" 2>&1 || {
  status=$?
  tail -n 100 "$build_log" >&2 || true
  exit "$status"
}

if [[ "$receipt_smoke" == 1 ]]; then
  phase=receipt-fixture
  if [[ -e "$fixture_log" || -L "$fixture_log" ]]; then
    printf 'Use a fresh receipt fixture evidence directory.\n' >&2
    exit 2
  fi
  node "$script_dir/ios-receipt-fixture.cjs" "$evidence" > "$fixture_log" 2>&1 &
  fixture_pid=$!
  ready=false
  for ((attempt = 0; attempt < 40; attempt++)); do
    kill -0 "$fixture_pid" 2>/dev/null || break
    if [[ -f "$evidence/receipt-fixture.ready" ]]; then ready=true; break; fi
    sleep 0.5
  done
  if ! $ready; then
    printf 'The local receipt fixture did not become ready before XCTest.\n' >&2
    exit 1
  fi
fi

phase=test
xcodebuild "${xcode_options[@]}" test-without-building -test-timeouts-enabled YES \
  -default-test-execution-time-allowance "$default_allowance" -maximum-test-execution-time-allowance "$maximum_allowance" \
  -resultBundlePath "$result_bundle" > "$test_log" 2>&1 || {
    status=$?
    tail -n 100 "$test_log" >&2 || true
    if [[ "$receipt_smoke" == 1 && -f "$evidence/receipt-fixture.json" ]]; then
      node "$script_dir/verify-ios-saved-receipt.cjs" "$simulator" "$evidence" \
        > "$evidence/saved-documents-at-failure.log" 2>&1 || true
    fi
    exit "$status"
  }
if [[ ! -d $result_bundle ]]; then
  printf 'Xcode did not write an XCTest result bundle.\n' >&2
  exit 1
fi

phase=verify
if [[ "$receipt_smoke" == 1 ]]; then
  wait "$fixture_pid"
  fixture_pid=''
  node "$script_dir/verify-ios-saved-receipt.cjs" "$simulator" "$evidence"
fi
xcrun xcresulttool get test-results summary --path "$result_bundle" > "$summary"
node - "$summary" <<'NODE'
const { readFileSync } = require('node:fs');
const { failedTests, passedTests, result, skippedTests, totalTestCount } =
  JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (result !== 'Passed' || !Number.isInteger(totalTestCount) || totalTestCount < 1 ||
    passedTests !== totalTestCount || failedTests !== 0 || skippedTests !== 0) {
  throw new Error('Xcode did not report a completed passing UI test.');
}
NODE

phase=passed
