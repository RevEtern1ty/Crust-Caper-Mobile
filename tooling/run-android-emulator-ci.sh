#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 4 || ( $2 != demo && $2 != stage ) ]]; then
  printf 'Usage: %s APK {demo|stage} EVIDENCE_DIR {28|35}\n' "$0" >&2
  exit 2
fi
apk=$1
profile=$2
evidence_dir=$3
api=$4
case "$api" in
  28) image='system-images;android-28;google_apis;x86_64' ;;
  35) image='system-images;android-35;default;x86_64' ;;
  *) printf 'Unsupported smoke API level %s.\n' "$api" >&2; exit 2 ;;
esac

android_tools="$ANDROID_HOME/cmdline-tools/latest/bin"
emulator="$ANDROID_HOME/emulator/emulator"
export ANDROID_AVD_HOME="$RUNNER_TEMP/crustcaper-android-avds"
export ANDROID_SERIAL=emulator-5554
export PATH="$ANDROID_HOME/platform-tools:$PATH"
mkdir -p "$evidence_dir" "$ANDROID_AVD_HOME"
exec > >(tee "$evidence_dir/runner.log") 2>&1

receipt="$evidence_dir/runner.txt"
emulator_pid=
cleanup() {
  local result=$?
  trap - EXIT
  if [[ -n "$emulator_pid" ]]; then
    timeout --kill-after=2s 8s adb emu kill >/dev/null 2>&1 || true
    kill "$emulator_pid" 2>/dev/null || true
    wait "$emulator_pid" 2>/dev/null || true
  fi
  printf 'smoke_exit_status=%s\n' "$result" >> "$receipt"
  exit "$result"
}
trap cleanup EXIT
candidate="$(git rev-parse HEAD)"
printf 'source_sha=%s\nprofile=%s\nsystem_image=%s\n' "$candidate" "$profile" "$image" > "$receipt"
test -s "$apk"
sha256sum "$apk" >> "$receipt"
test "$candidate" = "$GITHUB_SHA"
test "$(uname -m)" = x86_64
test -c /dev/kvm
sudo setfacl -m "u:$(id -u):rw" /dev/kvm
[[ -r /dev/kvm && -w /dev/kvm ]]

# QEMU loads the PulseAudio client library even with -no-audio.
if ! ldconfig -p | grep -F 'libpulse.so.0' >/dev/null; then
  timeout --kill-after=5s 2m sudo apt-get -o Acquire::Retries=2 update
  timeout --kill-after=5s 2m sudo apt-get -o Acquire::Retries=2 install -y --no-install-recommends libpulse0
fi
ldconfig -p | grep -F 'libpulse.so.0' >> "$receipt"

# Use the runner's existing SDK licenses, with no interactive acceptance.
timeout --kill-after=5s 6m "$android_tools/sdkmanager" --sdk_root="$ANDROID_HOME" --install emulator "$image" </dev/null
image_path="${image//;/\/}"
test -f "$ANDROID_HOME/$image_path/source.properties"
"$emulator" -version
"$emulator" -accel-check
printf 'no\n' | timeout --kill-after=2s 30s "$android_tools/avdmanager" create avd -n crustcaper-smoke -k "$image" --device pixel_5
timeout --kill-after=2s 15s adb start-server
timeout --kill-after=5s 12m "$emulator" -avd crustcaper-smoke -port 5554 \
  -accel on -gpu swiftshader -no-window -no-snapshot -no-audio -no-boot-anim \
  -cores 2 -memory 2048 > "$evidence_dir/emulator.log" 2>&1 &
emulator_pid=$!

boot_deadline=$((SECONDS + 180))
until [[ "$(timeout --kill-after=2s 8s adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)" == 1 ]]; do
  if ! kill -0 "$emulator_pid" 2>/dev/null || (( SECONDS >= boot_deadline )); then
    printf 'The Android emulator failed to boot within 180 seconds.\n' >&2
    tail -n 60 "$evidence_dir/emulator.log"
    exit 1
  fi
  sleep 2
done
observed_api="$(timeout --kill-after=2s 8s adb shell getprop ro.build.version.sdk | tr -d '\r')"
printf 'runtime_api=%s\n' "$observed_api" >> "$receipt"
test "$observed_api" = "$api"
timeout --kill-after=2s 12s adb shell input keyevent KEYCODE_WAKEUP
timeout --kill-after=2s 12s adb shell wm dismiss-keyguard
timeout --kill-after=55s 7m bash tooling/android-emulator-smoke.sh "$apk" "$profile" "$evidence_dir"
