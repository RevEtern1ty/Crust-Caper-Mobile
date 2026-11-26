#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 3 || ( $2 != demo && $2 != stage ) ]]; then
  printf 'Usage: bash tooling/android-emulator-smoke.sh APK {demo|stage} EVIDENCE_DIR\n' >&2
  exit 2
fi

apk=$1
profile=$2
evidence_dir=$3
package="com.crustcaper.mobile.$profile"
android_sdk=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}
build_tools=${CRUSTCAPER_ANDROID_BUILD_TOOLS:-$android_sdk/build-tools/36.0.0}
mkdir -p -- "$evidence_dir"
if [[ -e "$evidence_dir/evidence.txt" || -e "$evidence_dir/failure.txt" ]]; then
  printf 'Use a fresh Android smoke evidence directory.\n' >&2
  exit 2
fi

phase='Verify tools and APK'
serial=''
scratch_dir=''
remote_dir=''
install_attempted=false
install_owned=false
radios_owned=false
original_airplane=''
original_wifi=''
observed_pid=''
apk_hash=''

bounded_adb() {
  local duration=$1
  shift
  timeout --kill-after=2s "$duration" adb "$@"
}

device() {
  local duration=$1
  shift
  bounded_adb "$duration" -s "$serial" "$@"
}

device_text() {
  device "$@" | tr -d '\r'
}

phase_start() {
  phase=$1
  printf '\n%s\n' "$phase"
}

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

wifi_state() {
  local status first_line
  status=$(device_text 8s shell cmd wifi status) || return 1
  first_line=${status%%$'\n'*}
  case "$first_line" in
    'Wifi is enabled') printf 'enabled\n' ;;
    'Wifi is disabled') printf 'disabled\n' ;;
    *) return 1 ;;
  esac
}

capture_failure() {
  local crash_pid=$observed_pid
  device 8s exec-out screencap -p >"$evidence_dir/failure.png" 2>/dev/null || true
  if [[ -n "$remote_dir" ]]; then
    device 8s exec-out cat "$remote_dir/window.xml" >"$evidence_dir/failure.xml" 2>/dev/null || true
  fi
  if [[ -z "$crash_pid" ]]; then
    crash_pid=$(device_text 8s logcat -b crash -d -t 100 -v brief 'AndroidRuntime:E' '*:S' 2>/dev/null \
      | awk -v label="Process: $package, PID: " 'index($0, label) { candidate = substr($0, index($0, label) + length(label)); if (candidate ~ /^[0-9]+$/) pid = candidate } END { print pid }')
  fi
  if [[ "$crash_pid" =~ ^[1-9][0-9]*$ ]]; then
    device_text 8s logcat --pid="$crash_pid" -b main -b crash -d -t 160 -v threadtime \
      >"$evidence_dir/failure-app-logcat.txt" 2>/dev/null || true
  fi
}

finish() {
  local status=$?
  trap - EXIT
  set +e
  if (( status != 0 )) && { $radios_owned || $install_owned; }; then capture_failure; fi

  local cleanup_failed=false
  if [[ -n "$remote_dir" ]]; then
    device 8s shell rm -f "$remote_dir/window.xml" || cleanup_failed=true
    device 8s shell rmdir "$remote_dir" || cleanup_failed=true
  fi
  if $install_attempted && ! $install_owned; then
    # The package was absent beforehand. An interrupted ADB command can still commit the install.
    local packages_after_attempt
    if packages_after_attempt=$(device_text 8s shell pm list packages --user 0 "$package"); then
      if grep -Fxq "package:$package" <<< "$packages_after_attempt"; then install_owned=true; fi
    else
      cleanup_failed=true
    fi
  fi
  if $install_owned; then
    device 15s uninstall "$package" || cleanup_failed=true
  fi
  if $radios_owned; then
    if [[ "$original_airplane" == disabled ]]; then
      device 8s shell cmd connectivity airplane-mode disable || cleanup_failed=true
    fi
    if [[ $(wifi_state) != "$original_wifi" ]]; then
      device 8s shell cmd wifi set-wifi-enabled "$original_wifi" || cleanup_failed=true
    fi
  fi
  if [[ -n "$scratch_dir" ]]; then
    rm -f -- "$scratch_dir/base.apk" "$scratch_dir/window.xml" || cleanup_failed=true
    rmdir -- "$scratch_dir" || cleanup_failed=true
  fi
  if $cleanup_failed; then
    printf 'Android smoke could not finish all task-owned cleanup.\n' >&2
    if (( status == 0 )); then phase='Restore task-owned test state'; status=1; fi
  fi
  if (( status != 0 )); then
    printf 'Android emulator smoke failed\nPhase: %s\nProfile: %s\nPackage: %s\nAPK SHA-256: %s\nExit code: %s\n' \
      "$phase" "$profile" "$package" "${apk_hash:-unavailable}" "$status" | tee "$evidence_dir/failure.txt" >&2
  else
    printf 'Result: passed\n' | tee -a "$evidence_dir/evidence.txt"
  fi
  exit "$status"
}

trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for tool in adb timeout sha256sum unzip python3; do
  command -v "$tool" >/dev/null || fail "Missing required tool: $tool"
done
[[ -x "$build_tools/aapt" && -x "$build_tools/apksigner" ]] || fail 'Android build-tools aapt and apksigner are required.'
[[ -f "$apk" && -s "$apk" ]] || fail 'The APK must be an existing, nonempty file.'
apk="$(cd -- "$(dirname -- "$apk")" && pwd -P)/$(basename -- "$apk")"
read -r apk_hash _ < <(sha256sum -- "$apk")
[[ "$apk_hash" =~ ^[a-f0-9]{64}$ ]] || fail 'Unable to hash the APK.'
badging=$(timeout 12s "$build_tools/aapt" dump badging "$apk")
grep -Fq "package: name='$package'" <<< "$badging" || fail "Expected APK package $package."
if grep -q '^application-debuggable' <<< "$badging"; then fail 'Expected a non-debuggable Release APK.'; fi
signing=$(timeout 20s "$build_tools/apksigner" verify --print-certs "$apk")
grep -Eq '^Signer #[[:digit:]]+ certificate DN: .*CN=Android Debug([,[:space:]]|$)' <<< "$signing" \
  || fail 'Expected an Android Debug certificate on the Release APK.'
bundle_bytes=$(unzip -p "$apk" assets/index.android.bundle | wc -c)
(( bundle_bytes > 0 )) || fail 'The APK lacks the embedded Android JavaScript bundle.'

phase_start 'Validate the CI emulator'
devices=$(bounded_adb 8s devices | tr -d '\r')
mapfile -t targets < <(awk 'NR > 1 && NF { print $1, $2 }' <<< "$devices")
[[ ${#targets[@]} == 1 && ${targets[0]} =~ ^(emulator-[0-9]+)\ device$ ]] \
  || fail 'Expected exactly one attached, online Android emulator.'
serial=${BASH_REMATCH[1]}
[[ -z ${ANDROID_SERIAL:-} || $ANDROID_SERIAL == "$serial" ]] || fail 'ANDROID_SERIAL does not match the sole CI emulator.'
[[ $(device_text 8s get-state) == device ]] || fail 'The emulator did not report device state.'
[[ $(device_text 8s shell getprop ro.kernel.qemu) == 1 || $(device_text 8s shell getprop ro.boot.qemu) == 1 ]] \
  || fail 'The target did not report an emulator system property.'
[[ $(device_text 8s shell getprop sys.boot_completed) == 1 ]] || fail 'The CI runner must boot the emulator before the smoke test.'
android_api=$(device_text 8s shell getprop ro.build.version.sdk)
[[ "$android_api" =~ ^[0-9]+$ ]] || fail 'Unable to read the Android API level.'
[[ $(device_text 8s shell am get-current-user) == 0 ]] || fail 'Expected the CI emulator owner user.'

assert_no_reverse() {
  local mappings
  mappings=$(device_text 8s reverse --list) || fail 'Unable to verify ADB reverse mappings.'
  [[ -z ${mappings//[[:space:]]/} ]] || fail 'Expected an emulator with no ADB reverse mappings.'
}

network_is_offline() {
  local networks
  networks=$(device_text 8s shell dumpsys connectivity) || return 1
  grep -Eq '^[[:space:]]*Active default network:[[:space:]]*none[[:space:]]*$' <<< "$networks"
}

assert_no_reverse
installed_packages=$(device_text 8s shell pm list packages --user 0 "$package")
if grep -Fxq "package:$package" <<< "$installed_packages"; then fail "The emulator already has $package installed."; fi

phase_start 'Isolate emulator networking'
original_airplane=$(device_text 8s shell cmd connectivity airplane-mode)
[[ "$original_airplane" == enabled || "$original_airplane" == disabled ]] || fail 'Unable to read airplane-mode state.'
original_wifi=$(wifi_state) || fail 'Unable to read emulator Wi-Fi state.'
radios_owned=true
if [[ "$original_airplane" == disabled ]]; then device 8s shell cmd connectivity airplane-mode enable; fi
if [[ $(wifi_state) != disabled ]]; then device 8s shell cmd wifi set-wifi-enabled disabled; fi
for ((attempt = 0; attempt < 10; attempt++)); do
  if network_is_offline; then break; fi
  sleep 1
done
network_is_offline || fail 'The emulator still has an active default network.'
[[ $(device_text 8s shell cmd connectivity airplane-mode) == enabled && $(wifi_state) == disabled ]] \
  || fail 'The emulator did not enter airplane mode with Wi-Fi disabled.'

phase_start 'Install the verified Release APK'
install_attempted=true
install=$(device_text 90s install "$apk")
printf '%s\n' "$install"
grep -Fxq Success <<< "$install" || fail 'ADB did not confirm installation of the Release APK.'
install_owned=true
scratch_dir=$(mktemp -d "$evidence_dir/.android-smoke.XXXXXXXX")
installed_path=$(device_text 8s shell pm path --user 0 "$package")
[[ "$installed_path" =~ ^package:(/data/app/[A-Za-z0-9_./=~+-]+/base\.apk)$ ]] || fail 'Expected exactly one installed base APK.'
device 40s pull "${BASH_REMATCH[1]}" "$scratch_dir/base.apk" >/dev/null
read -r installed_hash _ < <(sha256sum -- "$scratch_dir/base.apk")
[[ "$installed_hash" == "$apk_hash" ]] || fail 'The installed base APK differs from the verified build artifact.'

phase_start 'Resolve the installed launcher activity'
resolved=$(device_text 8s shell cmd package resolve-activity --brief --user 0 \
  -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p "$package")
component=${resolved##*$'\n'}
[[ "$component" == "$package/"* && "${component#*/}" =~ ^[A-Za-z0-9_.]+$ ]] || fail 'Unable to resolve the installed launcher activity.'
candidate_dir=$(device_text 8s shell mktemp -d /data/local/tmp/crustcaper-smoke.XXXXXXXX)
[[ "$candidate_dir" =~ ^/data/local/tmp/crustcaper-smoke\.[A-Za-z0-9]+$ ]] || fail 'Unexpected emulator scratch directory.'
remote_dir=$candidate_dir
device 8s shell input keyevent KEYCODE_WAKEUP
device 8s shell wm dismiss-keyguard

app_pid() {
  local value
  value=$(device_text 5s shell pidof "$package") || return 1
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || return 1
  printf '%s\n' "$value"
}

dump_ui() {
  device 5s shell rm -f "$remote_dir/window.xml" >/dev/null || return 1
  device 9s shell uiautomator dump "$remote_dir/window.xml" >/dev/null || return 1
  device 5s exec-out cat "$remote_dir/window.xml" >"$scratch_dir/window.xml" || return 1
  [[ -s "$scratch_dir/window.xml" ]]
}

verify_ui() {
  python3 - "$scratch_dir/window.xml" "$package" "$profile" <<'PY'
import re
import sys
import xml.etree.ElementTree as ET

path, package, profile = sys.argv[1:]
try:
    root = ET.parse(path).getroot()
except (ET.ParseError, OSError) as error:
    sys.exit(f"Invalid UiAutomator hierarchy: {error}")

labels = set()
for node in root.iter("node"):
    if node.get("package") != package:
        continue
    bounds = re.fullmatch(r"\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]", node.get("bounds", ""))
    if not bounds:
        continue
    left, top, right, bottom = map(int, bounds.groups())
    if right <= max(0, left) or bottom <= max(0, top):
        continue
    labels.update(" ".join(node.get(name, "").split()) for name in ("text", "content-desc"))

required = {"CrustCaper", "Menu", "Orders", "Pickup"}
missing = required - labels
catalog = any(value == "Double Smash" or value.startswith("Double Smash,") for value in labels)
demo_badge = any("Demo store" in value for value in labels)
if profile == "demo":
    if not catalog:
        missing.add("Double Smash")
    if not demo_badge:
        missing.add("Demo store")
else:
    missing |= {"The menu could not load.", "Try again"} - labels
    if catalog or demo_badge:
        sys.exit("The stage app displayed a demo catalog or badge.")
if missing:
    sys.exit("Missing visible app labels: " + ", ".join(sorted(missing)))
PY
}

capture_screen() {
  device 8s exec-out screencap -p >"$1"
  python3 - "$1" <<'PY'
from pathlib import Path
import sys

with Path(sys.argv[1]).open("rb") as stream:
    header = stream.read(24)
if len(header) != 24 or header[:8] != b"\x89PNG\r\n\x1a\n" or header[12:16] != b"IHDR":
    sys.exit("The emulator screenshot is not a PNG.")
if not all(int.from_bytes(header[index:index+4], "big") for index in (16, 20)):
    sys.exit("The emulator screenshot has zero width or height.")
PY
}

cold_launch() {
  local tag=$1 previous_pid=$2 launch detail attempt deadline seconds
  phase_start "Cold launch: $tag"
  observed_pid=''
  network_is_offline || fail 'The emulator has an active network before launch.'
  assert_no_reverse
  device 8s shell am force-stop --user 0 "$package"
  if app_pid >/dev/null; then fail 'The app is still running after force-stop.'; fi
  launch=$(device_text 30s shell am start -W --user 0 -a android.intent.action.MAIN \
    -c android.intent.category.LAUNCHER -n "$component")
  printf '%s\n' "$launch" | tee "$evidence_dir/$tag-activity.txt"
  grep -Eq '^Status:[[:space:]]+ok[[:space:]]*$' <<< "$launch" || fail 'Activity Manager did not report a successful launch.'
  if grep -q '^LaunchState:' <<< "$launch" && ! grep -Eq '^LaunchState:[[:space:]]+COLD[[:space:]]*$' <<< "$launch"; then
    fail 'Activity Manager did not report a cold launch.'
  fi
  for ((attempt = 0; attempt < 5; attempt++)); do
    if observed_pid=$(app_pid); then break; fi
    sleep 1
  done
  [[ -n "$observed_pid" && "$observed_pid" != "$previous_pid" ]] || fail 'Cold launch did not produce a new app PID.'

  phase_start "Verify visible app UI: $tag"
  detail='No usable UiAutomator hierarchy.'
  deadline=$((SECONDS + 45))
  for ((attempt = 0; attempt < 14 && SECONDS < deadline; attempt++)); do
    [[ $(app_pid) == "$observed_pid" ]] || fail 'The app exited or restarted while rendering its UI.'
    if dump_ui && detail=$(verify_ui 2>&1); then break; fi
    sleep 1
  done
  [[ -z "$detail" ]] || fail "The expected $profile UI did not render. $detail"

  phase_start "Observe a stable app process: $tag"
  for ((seconds = 0; seconds < 10; seconds++)); do
    sleep 1
    [[ $(app_pid) == "$observed_pid" ]] || fail 'The app exited or changed PID during the 10-second observation.'
  done
  dump_ui && verify_ui || fail 'The required app UI did not remain visible after observation.'
  cp -- "$scratch_dir/window.xml" "$evidence_dir/$tag.xml"
  capture_screen "$evidence_dir/$tag.png"
  [[ $(app_pid) == "$observed_pid" ]] || fail 'The app exited or changed PID during screenshot capture.'
  network_is_offline || fail 'The emulator gained a default network during the smoke test.'
  assert_no_reverse
  printf 'App UI and PID %s stayed stable for at least 10 seconds: %s\n' "$observed_pid" "$tag"
}

cold_launch first-launch ''
first_pid=$observed_pid
cold_launch second-launch "$first_pid"

printf 'Profile: %s\nPackage: %s\nEmulator: %s\nAndroid API: %s\nAPK SHA-256: %s\nInstalled APK SHA-256: %s\nEmbedded JS bytes: %s\nLauncher: %s\nNetwork: no active default network or ADB reverse mappings\nCold launch PIDs: %s, %s\nStable UI observation: at least 10 seconds per launch\n' \
  "$profile" "$package" "$serial" "$android_api" "$apk_hash" "$installed_hash" "$bundle_bytes" "$component" \
  "$first_pid" "$observed_pid" | tee "$evidence_dir/evidence.txt"
