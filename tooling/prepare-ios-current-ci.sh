#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || -z ${1:-} || -z ${GITHUB_OUTPUT:-} ]]; then
  printf 'Usage: GITHUB_OUTPUT=PATH bash tooling/prepare-ios-current-ci.sh EVIDENCE_DIR\n' >&2
  exit 2
fi

umask 077
mkdir -p -- "$1"
receipt="$1/control-runtime.txt"
runtime=com.apple.CoreSimulator.SimRuntime.iOS-26-5
device_type=com.apple.CoreSimulator.SimDeviceType.iPhone-17
xcodebuild -version | tee "$receipt"
xcrun simctl list runtimes --json | node -e '
  const { runtimes } = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  const entries = runtimes.filter(entry => entry.identifier === process.argv[1] && entry.isAvailable);
  if (entries.length !== 1 || entries[0].version !== "26.5" || entries[0].buildversion !== "23F77") {
    throw new Error("Expected the available iOS 26.5 runtime (23F77).");
  }
' "$runtime"
simulator=$(xcrun simctl create 'iPhone 17' "$device_type" "$runtime")
[[ "$simulator" =~ ^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$ ]]
printf 'simulator=%s\n' "$simulator" >> "$GITHUB_OUTPUT"
xcrun simctl boot "$simulator"
xcrun simctl bootstatus "$simulator" -b
printf 'Simulator UUID: %s\nRuntime: %s\nBooted: iPhone 17 on iOS 26.5 (23F77)\n' \
  "$simulator" "$runtime" | tee -a "$receipt"
