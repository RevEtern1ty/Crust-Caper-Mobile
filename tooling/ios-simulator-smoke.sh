#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 || ( ${2:-demo} != demo && ${2:-demo} != local ) ]]; then
  printf 'Usage: bash tooling/ios-simulator-smoke.sh EVIDENCE_DIR [demo|local]\n' >&2
  exit 2
fi

cd "$(dirname "${BASH_SOURCE[0]}")/.."
evidence_dir=$1
profile=${2:-demo}
export CRUSTCAPER_BUILD_PROFILE="$profile"
simulator_hint=''
checkout_smoke=${CRUSTCAPER_IOS_ORDER_SMOKE:-0}
checkout_runtime=${CRUSTCAPER_IOS_ORDER_RUNTIME:-16-0}
if [[ "$profile" == local ]]; then
  export CRUSTCAPER_API_BASE_URL=${CRUSTCAPER_API_BASE_URL:-http://127.0.0.1:18080/api/v1}
  if [[ ! "$CRUSTCAPER_API_BASE_URL" =~ ^http://127\.0\.0\.1:([1-9][0-9]{0,4})/api/v1$ ]] || (( BASH_REMATCH[1] > 65535 )); then
    printf 'Local iOS smoke requires CRUSTCAPER_API_BASE_URL=http://127.0.0.1:PORT/api/v1.\n' >&2
    exit 2
  fi
  simulator_hint=${CRUSTCAPER_IOS_SIMULATOR_UDID:-}
  if [[ -n "$simulator_hint" && ! "$simulator_hint" =~ ^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$ ]]; then
    printf 'CRUSTCAPER_IOS_SIMULATOR_UDID must be the UUID of an available iPhone simulator.\n' >&2
    exit 2
  fi
  export CRUSTCAPER_STORE_ID=${CRUSTCAPER_STORE_ID:-kigali}
  export CRUSTCAPER_WEB_CHECKOUT=false EXPO_NO_DOTENV=1 EXPO_NO_TELEMETRY=1
fi
if [[ "$checkout_smoke" == 1 && ( "$profile" != local || -z "$simulator_hint" ) ]]; then
  printf 'The iOS checkout smoke requires local Release and the exact simulator UUID.\n' >&2
  exit 2
fi
if [[ "$checkout_smoke" == 1 && "$checkout_runtime" != 16-0 && "$checkout_runtime" != 26-5 ]]; then
  printf 'The iOS checkout smoke requires the iOS 16.0 or 26.5 test runtime.\n' >&2
  exit 2
fi
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
if [[ $(uname -s) != Darwin || $(uname -m) != arm64 ]]; then
  printf 'An Apple silicon runner is required for this smoke test.\n' >&2
  exit 1
fi
xcode_version=$(xcodebuild -version)
printf '%s\n' "$xcode_version"
pod --version

if [[ "$profile" == local ]]; then
  start_phase 'Verify the connected local iOS configuration'
  source_sha=$(git rev-parse HEAD)
  source_state=clean
  if [[ -n $(git status --porcelain) ]]; then source_state=dirty; fi
  local_config=$(npx --no-install expo config --type public --json | node -e '
    const config = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    const restaurant = config.extra?.restaurant;
    const ios = config.ios;
    const ats = ios?.infoPlist?.NSAppTransportSecurity;
    if (restaurant?.profile !== "local" || restaurant.apiBaseUrl !== process.env.CRUSTCAPER_API_BASE_URL
      || restaurant.storeId !== process.env.CRUSTCAPER_STORE_ID || restaurant.webCheckout === true
      || ios?.bundleIdentifier !== "com.crustcaper.mobile.local"
      || ats?.NSAllowsArbitraryLoads !== false || ats.NSAllowsLocalNetworking !== true) {
      console.error("Unexpected connected local iOS configuration.");
      process.exit(1);
    }
    console.log([ios.bundleIdentifier, ats.NSAllowsArbitraryLoads, ats.NSAllowsLocalNetworking].join("\t"));
  ')
  IFS=$'\t' read -r expected_id expected_arbitrary_http expected_local_networking <<< "$local_config"
else
  expected_id=$(node -p 'require("./app.json").expo.ios.bundleIdentifier')
  expected_arbitrary_http=false
fi

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

derived_data=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/crustcaper-ios.XXXXXX")
xcode_flags=(ARCHS=arm64 ONLY_ACTIVE_ARCH=NO)
if [[ "$checkout_smoke" == 1 ]]; then
  start_phase 'Configure the local simulator app identity for Keychain'
  checkout_identity="CRUSTCAPER.$expected_id"
  ruby tooling/ios-checkout-signing-ci.rb "${projects[0]}" "$derived_data/checkout.entitlements"
  start_phase 'Build locally signed Release for iOS Simulator'
else
  xcode_flags+=(CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO)
  start_phase 'Build unsigned Release for iOS Simulator'
fi

# Release uses embedded JS. Metro and the automatic packager stay off.
export RCT_NO_LAUNCH_PACKAGER=1
build_log="$derived_data/xcodebuild.log"
xcodebuild -quiet -workspace "$workspace" -scheme "$scheme" -configuration Release \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$derived_data" -jobs 2 \
  "${xcode_flags[@]}" build >"$build_log" 2>&1 || {
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
expected_minimum=$(node -p 'require("./app.json").expo.plugins.find(p => Array.isArray(p) && p[0] === "expo-build-properties")[1].ios.deploymentTarget')
bundle_id=$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$plist")
minimum_os=$(/usr/libexec/PlistBuddy -c 'Print MinimumOSVersion' "$plist")
executable=$(/usr/libexec/PlistBuddy -c 'Print CFBundleExecutable' "$plist")
arbitrary_http=$(/usr/libexec/PlistBuddy -c 'Print :NSAppTransportSecurity:NSAllowsArbitraryLoads' "$plist")
arch=$(xcrun lipo -archs "$app/$executable")
test "$bundle_id" = "$expected_id"
test "$minimum_os" = "$expected_minimum"
test "$arch" = arm64
test "$arbitrary_http" = "$expected_arbitrary_http"
if [[ "$profile" == local ]]; then
  local_networking=$(/usr/libexec/PlistBuddy -c 'Print :NSAppTransportSecurity:NSAllowsLocalNetworking' "$plist")
  test "$local_networking" = "$expected_local_networking"
fi
test -s "$app/main.jsbundle"
bundle_bytes=$(wc -c < "$app/main.jsbundle" | tr -d '[:space:]')

if [[ "$checkout_smoke" == 1 ]]; then
  start_phase 'Verify the simulator app Keychain identity before installation'
  codesign --verify --strict "$app"
  embedded_entitlements="$derived_data/checkout-embedded.plist"
  if codesign --display --entitlements :- "$app" > "$embedded_entitlements" 2>/dev/null \
      && [[ $(/usr/libexec/PlistBuddy -c 'Print :application-identifier' "$embedded_entitlements" 2>/dev/null) == "$checkout_identity" ]]; then
    entitlement_source='code signature'
  else
    # Xcode can link simulator entitlements in the main Mach-O instead of signing them.
    section=$(xcrun otool -l "$app/$executable" | awk '
      $1 == "sectname" { found = ($2 == "__entitlements"); size = "" }
      found && $1 == "segname" && $2 != "__TEXT" { found = 0 }
      found && $1 == "size" { size = $2 }
      found && $1 == "offset" { print size, $2; found = 0 }
    ')
    if [[ ! "$section" =~ ^(0x[0-9A-Fa-f]+)\ ([0-9]+)$ ]]; then
      printf 'Xcode did not embed the simulator Keychain identity.\n' >&2
      exit 1
    fi
    section_bytes=$(( BASH_REMATCH[1] ))
    section_offset=${BASH_REMATCH[2]}
    dd if="$app/$executable" of="$embedded_entitlements" bs=1 skip="$section_offset" count="$section_bytes" 2>/dev/null
    test "$(/usr/libexec/PlistBuddy -c 'Print :application-identifier' "$embedded_entitlements")" = "$checkout_identity"
    entitlement_source='linked Mach-O section'
  fi
  printf 'App signature: local ad hoc\nKeychain application identifier: %s\nEntitlement source: %s\n' \
    "$checkout_identity" "$entitlement_source" | tee "$evidence_dir/checkout-signing.txt"
fi

start_phase 'Select an available iPhone simulator'
selected_device=$(xcrun simctl list devices available --json | node -e '
  const { devices } = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  const requested = process.argv[1]?.toLowerCase();
  const runtimePrefix = "com.apple.CoreSimulator.SimRuntime.iOS-";
  const runtimes = Object.keys(devices)
    .filter(runtime => runtime.startsWith(runtimePrefix))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const runtime of runtimes) {
    const phones = devices[runtime].filter(device => device.isAvailable && /^iPhone\b/.test(device.name));
    const phone = requested ? phones.find(device => device.udid.toLowerCase() === requested)
      : phones.find(device => /^iPhone \d+$/.test(device.name)) ?? phones[0];
    if (!phone) continue;
    console.log([phone.udid, phone.name, runtime.slice(runtimePrefix.length), phone.state].join("\t"));
    process.exit(0);
  }
  console.error(requested ? "The chosen iPhone simulator is unavailable." : "No available iPhone simulator is installed.");
  process.exitCode = 1;
' "$simulator_hint")
IFS=$'\t' read -r simulator device runtime state <<< "$selected_device"
if [[ "$checkout_smoke" == 1 && "$runtime" != "$checkout_runtime" ]]; then
  printf 'The iOS checkout smoke requires the verified iOS %s simulator.\n' "$checkout_runtime" >&2
  exit 1
fi
printf 'Using %s on iOS %s (%s), state %s.\n' "$device" "$runtime" "$simulator" "$state"
start_phase 'Boot the iPhone simulator'
if [[ "$state" == Shutdown ]]; then
  simulator_to_shutdown=$simulator
  xcrun simctl boot "$simulator"
fi
xcrun simctl bootstatus "$simulator" -b
start_phase 'Install the Release app'
xcrun simctl install "$simulator" "$app"
if [[ "$profile" == local ]]; then
  start_phase 'Verify the installed local Release matches the build'
  installed_app=$(xcrun simctl get_app_container "$simulator" "$bundle_id" app)
  cmp -s "$app/$executable" "$installed_app/$executable"
  cmp -s "$app/main.jsbundle" "$installed_app/main.jsbundle"
fi
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
if [[ "$profile" == local ]]; then
  executable_sha=$(shasum -a 256 "$app/$executable" | cut -d ' ' -f 1)
  bundle_sha=$(shasum -a 256 "$app/main.jsbundle" | cut -d ' ' -f 1)
  printf 'Profile: local\nSource SHA: %s\nCheckout: %s\nConfigured API: %s\nConfigured store: %s\nSimulator UUID: %s\nATS arbitrary loads: %s\nATS local networking: %s\nExecutable SHA-256: %s\nEmbedded JS SHA-256: %s\n%s\nInstalled executable and embedded JS match the build.\nScope: Release simulator build, install and launch.\n' \
    "$source_sha" "$source_state" "$CRUSTCAPER_API_BASE_URL" "$CRUSTCAPER_STORE_ID" "$simulator" \
    "$arbitrary_http" "$local_networking" "$executable_sha" "$bundle_sha" "$xcode_version" \
    | tee -a "$evidence_dir/evidence.txt"
fi
if [[ "$checkout_smoke" == 1 ]]; then
  start_phase 'Verify checkout through the installed iOS Release'
  bash tooling/ios-order-ui-ci.sh "$simulator" "$evidence_dir/checkout"
  installed_app=$(xcrun simctl get_app_container "$simulator" "$bundle_id" app)
  cmp -s "$app/$executable" "$installed_app/$executable"
  cmp -s "$app/main.jsbundle" "$installed_app/main.jsbundle"
  printf 'Installed executable and embedded JS still match after checkout.\n' >> "$evidence_dir/evidence.txt"
fi
