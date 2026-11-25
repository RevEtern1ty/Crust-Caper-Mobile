#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
evidence_dir=$1
mkdir -p "$evidence_dir"

phase='Verify runner tools'
failure_command=''
simulator_to_shutdown=''

start_phase() {
  phase=$1
  printf '\n%s\n' "$phase"
}

finish_smoke() {
  local exit_status=$?
  if (( exit_status != 0 )); then
    printf '::error title=iOS simulator smoke failed::%s (exit %s)\n' "$phase" "$exit_status" >&2
    printf 'Phase: %s\nExit code: %s\n%s\n' "$phase" "$exit_status" "$failure_command" \
      | tee "$evidence_dir/failure.txt" >&2
  fi
  if [[ -n "$simulator_to_shutdown" ]]; then
    xcrun simctl shutdown "$simulator_to_shutdown" || true
  fi
}

trap 'failure_command="Line $LINENO: $BASH_COMMAND"' ERR
trap finish_smoke EXIT
start_phase "$phase"
if [[ $(uname -m) != arm64 ]]; then
  printf 'An Apple silicon runner is required for this smoke test.\n' >&2
  exit 1
fi
xcodebuild -version
pod --version

start_phase 'Generate Expo iOS project'
npx --no-install expo prebuild --platform ios --no-install
start_phase 'Install CocoaPods dependencies'
pod install --project-directory=ios

start_phase 'Resolve Xcode project and workspace'
shopt -s nullglob
projects=(ios/*.xcodeproj)
if [[ ${#projects[@]} != 1 ]]; then
  printf 'Expected exactly one generated iOS app project.\n' >&2
  exit 1
fi
project_name=${projects[0]##*/}
scheme=${project_name%.xcodeproj}
workspace="ios/$scheme.xcworkspace"
test -d "$workspace"

# Release uses embedded JS. Metro and the automatic packager stay off.
start_phase 'Build unsigned Release for iOS Simulator'
export RCT_NO_LAUNCH_PACKAGER=1
derived_data=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/crustcaper-ios.XXXXXX")
build_log="$derived_data/xcodebuild.log"
xcodebuild -quiet -workspace "$workspace" -scheme "$scheme" -configuration Release \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$derived_data" -jobs 2 \
  ARCHS=arm64 ONLY_ACTIVE_ARCH=NO CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build >"$build_log" 2>&1 || {
    build_exit_status=$?
    tail -n 120 "$build_log" >&2
    exit "$build_exit_status"
  }

start_phase 'Validate the Release app and its embedded bundle'
apps=("$derived_data"/Build/Products/Release-iphonesimulator/*.app)
if [[ ${#apps[@]} != 1 ]]; then
  printf 'Expected exactly one Release simulator app.\n' >&2
  exit 1
fi
app=${apps[0]}
plist="$app/Info.plist"
expected_id=$(node -p 'require("./app.json").expo.ios.bundleIdentifier')
expected_minimum=$(node -p 'require("./app.json").expo.plugins.find(p => Array.isArray(p) && p[0] === "expo-build-properties")[1].ios.deploymentTarget')
bundle_id=$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$plist")
minimum_os=$(/usr/libexec/PlistBuddy -c 'Print MinimumOSVersion' "$plist")
executable=$(/usr/libexec/PlistBuddy -c 'Print CFBundleExecutable' "$plist")
arbitrary_http=$(/usr/libexec/PlistBuddy -c 'Print :NSAppTransportSecurity:NSAllowsArbitraryLoads' "$plist")
arch=$(xcrun lipo -archs "$app/$executable")
test "$bundle_id" = "$expected_id"
test "$minimum_os" = "$expected_minimum"
test "$arch" = arm64
test "$arbitrary_http" = false
test -s "$app/main.jsbundle"
bundle_bytes=$(wc -c < "$app/main.jsbundle" | tr -d '[:space:]')

start_phase 'Select an available iPhone simulator'
selected_device=$(xcrun simctl list devices available --json | node -e '
  const { devices } = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  const runtimePrefix = "com.apple.CoreSimulator.SimRuntime.iOS-";
  const runtimes = Object.keys(devices)
    .filter(runtime => runtime.startsWith(runtimePrefix))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const runtime of runtimes) {
    const phones = devices[runtime].filter(device => device.isAvailable && /^iPhone\b/.test(device.name));
    const phone = phones.find(device => /^iPhone \d+$/.test(device.name)) ?? phones[0];
    if (!phone) continue;
    console.log([phone.udid, phone.name, runtime.slice(runtimePrefix.length), phone.state].join("\t"));
    process.exit(0);
  }
  console.error("No available iPhone simulator is installed.");
  process.exitCode = 1;
')
IFS=$'\t' read -r simulator device runtime state <<< "$selected_device"
printf 'Using %s on iOS %s (%s), state %s.\n' "$device" "$runtime" "$simulator" "$state"
start_phase 'Boot the iPhone simulator'
if [[ "$state" == Shutdown ]]; then
  simulator_to_shutdown=$simulator
  xcrun simctl boot "$simulator"
fi
xcrun simctl bootstatus "$simulator" -b
start_phase 'Install the Release app'
xcrun simctl install "$simulator" "$app"
start_phase 'Launch the Release app'
launch=$(xcrun simctl launch --terminate-running-process "$simulator" "$bundle_id")
printf '%s\n' "$launch"
pid=${launch##*: }
if [[ "$launch" != "$bundle_id: $pid" || ! "$pid" =~ ^[0-9]+$ ]]; then
  printf 'Simulator launch did not return a process ID for %s.\n' "$bundle_id" >&2
  exit 1
fi

start_phase 'Observe the running app and capture the screenshot'
for (( seconds = 0; seconds < 10; seconds++ )); do
  if ! kill -0 "$pid"; then
    printf 'App process exited before the 10-second smoke interval ended.\n' >&2
    exit 1
  fi
  sleep 1
done
kill -0 "$pid"
xcrun simctl io "$simulator" screenshot "$evidence_dir/launch.png"
test -s "$evidence_dir/launch.png"
kill -0 "$pid"
printf 'Release: %s\nMinimum OS: %s\nArchitecture: %s\nEmbedded JS: %s bytes\nSimulator: %s on iOS %s\nStable process: PID %s for 10 seconds and through screenshot\n' \
  "$bundle_id" "$minimum_os" "$arch" "$bundle_bytes" "$device" "$runtime" "$pid" \
  | tee "$evidence_dir/evidence.txt"
