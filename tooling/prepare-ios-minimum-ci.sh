#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 || -z $1 || -z ${GITHUB_OUTPUT:-} ]]; then
  printf 'Usage: GITHUB_OUTPUT=PATH bash tooling/prepare-ios-minimum-ci.sh EVIDENCE_DIR [RUNTIME_INSTALL_DEVELOPER_DIR]\n' >&2
  exit 2
fi

umask 077
mkdir -p -- "$1"
evidence_dir=$(cd -- "$1" && pwd -P)
receipt="$evidence_dir/minimum-provisioning.txt"
failure_receipt="$evidence_dir/minimum-provisioning-failure.txt"
if [[ -e "$receipt" || -e "$failure_receipt" ]]; then
  printf 'Use a fresh iOS minimum provisioning evidence directory.\n' >&2
  exit 2
fi

runtime_id=com.apple.CoreSimulator.SimRuntime.iOS-16-0
runtime_version=16.0
runtime_build=20A360
device_id=com.apple.CoreSimulator.SimDeviceType.iPhone-14
device_name='iPhone 14'
phase='Verify the Apple silicon runner'
failure='The provisioning command did not finish.'
scratch=''

record() {
  printf '%s\n' "$@" | tee -a "$receipt"
}

fail() {
  failure=$1
  exit 1
}

finish() {
  local status=$?
  trap - EXIT
  set +e
  if [[ -n "$scratch" ]] && ! rm -rf -- "$scratch" && (( status == 0 )); then
    phase='Remove the task-owned download directory'
    failure='Unable to remove the temporary runtime download.'
    status=1
  fi
  if (( status != 0 )); then
    printf 'Phase: %s\nExit code: %s\n%s\n' "$phase" "$status" "$failure" | tee "$failure_receipt" >&2
  fi
  exit "$status"
}

trap finish EXIT
trap 'failure="Interrupted."; exit 130' INT
trap 'failure="Terminated."; exit 143' TERM
record "Requested runtime: iOS $runtime_version ($runtime_build)" "Runtime identifier: $runtime_id"
[[ $(uname -s) == Darwin && $(uname -m) == arm64 ]] || fail 'An Apple silicon macOS runner is required.'
[[ -n ${DEVELOPER_DIR:-} && -d "$DEVELOPER_DIR" ]] || fail 'Set DEVELOPER_DIR to the selected Xcode developer directory.'
host_version=$(sw_vers -productVersion 2>/dev/null) || fail 'Unable to identify the macOS version.'
xcode_version=$(xcodebuild -version 2>/dev/null) || fail 'Unable to identify the selected Xcode.'
xcode_release=${xcode_version%%$'\n'*}
xcode_build=${xcode_version#*$'\n'}
[[ $host_version =~ ^[0-9]+(\.[0-9]+)+$ && $xcode_release =~ ^Xcode\ [0-9]+(\.[0-9]+)+$ \
  && $xcode_build =~ ^Build\ version\ [0-9A-Za-z]+$ ]] || fail 'Unexpected macOS or Xcode version format.'
record "Host: macOS $host_version (arm64)" "$xcode_release" "$xcode_build"

probe_runtime() {
  local inventory
  inventory=$(xcrun simctl list runtimes --json 2>/dev/null) || return 2
  node -e '
    try {
      const [identifier, version, build] = process.argv.slice(1);
      const { runtimes } = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
      const entries = runtimes.filter(runtime => runtime.identifier === identifier && runtime.isAvailable === true);
      process.exit(entries.length === 1 && entries[0].version === version && entries[0].buildversion === build ? 0 : 1);
    } catch { process.exit(2); }
  ' "$runtime_id" "$runtime_version" "$runtime_build" <<< "$inventory"
}

run_apple_platform_command() {
  local action=$1 log="$scratch/apple-platform.log" status reason
  shift
  # Keep vendor output private. Report only allowlisted categories and the exit status.
  if "$@" >"$log" 2>&1; then
    rm -- "$log"
    return
  else
    status=$?
  fi
  if grep -Eiq 'not authorized|unauthorized|authentication required|sign[ -]?in|sign in|Apple (ID|Account).*(required|permission)|HTTP[^[:cntrl:]]*[[:space:]](401|403)([^0-9]|$)' "$log"; then
    reason='authentication or authorization required'
  elif grep -Eiq 'no space left on device|ENOSPC|NSFileWriteOutOfSpace|not enough[^[:cntrl:]]*space|insufficient[^[:cntrl:]]*space' "$log"; then
    reason='insufficient disk space'
  elif grep -Eiq '(runtime|platform|asset|version)[^[:cntrl:]]*(not available|unavailable|not found)|no (matching|compatible) (runtime|platform|asset|version)' "$log"; then
    reason='the exact runtime was unavailable in the Apple platform catalog'
  else
    reason='unclassified Apple platform service failure'
  fi
  fail "Apple runtime $action exited with status $status ($reason)."
}

phase='Inspect the installed iOS simulator runtimes'
runtime_source=installed
if probe_runtime; then
  :
else
  [[ $? == 1 ]] || fail 'Unable to read the simulator runtime inventory.'
  phase='Download iOS 16.0 from Apple'
  record "Phase: $phase"
  installer_dir=${2:-$DEVELOPER_DIR}
  if [[ $installer_dir != "$DEVELOPER_DIR" ]]; then
    [[ -d $installer_dir ]] || fail 'The runtime installer Xcode developer directory is unavailable.'
    installer_version=$(DEVELOPER_DIR="$installer_dir" xcodebuild -version 2>/dev/null) \
      || fail 'Unable to identify the runtime installer Xcode.'
    installer_release=${installer_version%%$'\n'*}
    installer_build=${installer_version#*$'\n'}
    [[ $installer_release =~ ^Xcode\ [0-9]+(\.[0-9]+)+$ && $installer_build =~ ^Build\ version\ [0-9A-Za-z]+$ ]] \
      || fail 'Unexpected runtime installer Xcode version format.'
    record "Runtime installer: $installer_release (${installer_build#Build version })"
  fi
  scratch=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/crustcaper-ios-minimum.XXXXXXXX")
  run_apple_platform_command download env DEVELOPER_DIR="$installer_dir" xcodebuild \
    -downloadPlatform iOS -exportPath "$scratch" -buildVersion "$runtime_version"
  set -- "$scratch"/*.dmg
  [[ $# == 1 && -f $1 && -s $1 && ! -L $1 ]] \
    || fail 'Expected exactly one regular simulator runtime disk image from Apple.'
  phase='Import the Apple simulator runtime'
  record "Phase: $phase"
  run_apple_platform_command import env DEVELOPER_DIR="$installer_dir" xcodebuild -importPlatform "$1"
  phase='Verify the imported iOS simulator runtime'
  probe_runtime || fail 'The exact iOS 16.0 (20A360) runtime is unavailable after import.'
  runtime_source=Apple-download
fi
record "Verified runtime: iOS $runtime_version ($runtime_build)" "Runtime source: $runtime_source"

phase='Create the iPhone 14 simulator'
simulator=$(xcrun simctl create "$device_name" "$device_id" "$runtime_id" 2>/dev/null) \
  || fail 'CoreSimulator could not create the iPhone 14 on the exact runtime.'
[[ $simulator =~ ^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$ ]] \
  || fail 'CoreSimulator did not return a simulator UUID.'
printf 'simulator=%s\n' "$simulator" >> "$GITHUB_OUTPUT"
record "Device: $device_name" "Device type identifier: $device_id" "Simulator UUID: $simulator"

phase='Boot the exact iOS 16.0 simulator'
record "Phase: $phase"
xcrun simctl boot "$simulator" >/dev/null 2>&1 || fail "Simulator boot exited with status $?."
xcrun simctl bootstatus "$simulator" -b >/dev/null 2>&1 || fail "Simulator bootstatus exited with status $?."

phase='Verify the booted device and runtime'
inventory=$(xcrun simctl list devices available --json 2>/dev/null) || fail 'Unable to read the simulator device inventory.'
node -e '
  try {
    const [runtime, udid, name, type] = process.argv.slice(1);
    const { devices } = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    const matches = (devices[runtime] ?? []).filter(device => device.udid === udid);
    const device = matches[0];
    process.exit(matches.length === 1 && device.name === name && device.deviceTypeIdentifier === type
      && device.isAvailable === true && device.state === "Booted" ? 0 : 1);
  } catch { process.exit(1); }
' "$runtime_id" "$simulator" "$device_name" "$device_id" <<< "$inventory" \
  || fail 'The created iPhone 14 did not boot on the exact available runtime.'
record "Booted: $device_name on iOS $runtime_version ($runtime_build)" 'Result: passed'
