#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
temporary_parent=$(cd -- "${TMPDIR:-/tmp}" && pwd -P)
fixture=$(mktemp -d "$temporary_parent/crustcaper-android-smoke-mock.XXXXXXXX")
trap 'if [[ -d "$fixture" && ! -L "$fixture" && "$fixture" == "$temporary_parent"/crustcaper-android-smoke-mock.* ]]; then rm -rf -- "$fixture"; fi' EXIT
export SMOKE_FIXTURE=$fixture
export CRUSTCAPER_ANDROID_BUILD_TOOLS="$fixture/bin"
export PATH="$fixture/bin:$PATH"
unset ANDROID_SERIAL
mkdir -p "$fixture/bin"

cat >"$fixture/bin/aapt" <<'SH'
#!/usr/bin/env bash
printf "package: name='com.crustcaper.mobile.%s' versionCode='1'\n" "$SMOKE_MOCK_PROFILE"
SH
cat >"$fixture/bin/apksigner" <<'SH'
#!/usr/bin/env bash
printf 'Signer #1 certificate DN: CN=Android Debug, O=Android\n'
SH
cat >"$fixture/bin/sleep" <<'SH'
#!/usr/bin/env bash
[[ $1 == 1 ]] || exit 1
printf 'sample\n' >>"$SMOKE_FIXTURE/samples"
SH
cat >"$fixture/bin/adb" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
cd -- "$SMOKE_FIXTURE"
if [[ $1 == devices ]]; then
  if [[ $SMOKE_MOCK_SCENARIO == physical ]]; then id=physical-device; else id=emulator-5554; fi
  printf 'List of devices attached\n%s\tdevice\n\n' "$id"
  exit
fi
[[ $1 == -s && $2 == emulator-5554 ]] || exit 88
shift 2
printf '%s\n' "$*" >>commands
package="com.crustcaper.mobile.$SMOKE_MOCK_PROFILE"
case "$1" in
  get-state) printf 'device\n' ;;
  reverse)
    [[ $2 == --list ]]
    if [[ $SMOKE_MOCK_SCENARIO == reverse ]]; then printf 'tcp:8081 tcp:8081\n'; fi ;;
  install)
    [[ $2 == "$SMOKE_FIXTURE/fixture.apk" ]]
    touch installed
    if [[ $SMOKE_MOCK_SCENARIO == lost-install-reply ]]; then exit 1; fi
    printf 'Success\n' ;;
  pull)
    if [[ $SMOKE_MOCK_SCENARIO == wrong-bytes ]]; then printf 'Different bytes' >"$3"; else cp fixture.apk "$3"; fi ;;
  uninstall) [[ $2 == "$package" && -f installed ]]; rm -- installed; printf 'Success\n' ;;
  logcat) printf 'Mock app failure\n' ;;
  exec-out)
    if [[ $2 == cat ]]; then
      labels=('CrustCaper' 'Menu' 'Orders' 'Pickup')
      if [[ $SMOKE_MOCK_PROFILE == demo || $SMOKE_MOCK_SCENARIO == wrong-ui ]]; then
        labels+=('Double Smash, 9,200 RWF' 'Demo store · No slots available')
      else
        labels+=('The menu could not load.' 'Try again')
      fi
      printf '<hierarchy>'
      for label in "${labels[@]}"; do
        printf '<node package="%s" bounds="[1,1][30,30]" content-desc="%s"/>' "$package" "$label"
      done
      printf '</hierarchy>\n'
    else
      [[ $2 == screencap && $3 == -p ]]
      printf '\211PNG\r\n\032\n\000\000\000\015IHDR\000\000\000\001\000\000\000\001'
    fi ;;
  shell)
    shift
    case "$*" in
      'getprop ro.kernel.qemu'|'getprop sys.boot_completed') printf '1\n' ;;
      'getprop ro.build.version.sdk') printf '35\n' ;;
      'am get-current-user') printf '0\n' ;;
      'pm list packages '*) if [[ -f installed ]]; then printf 'package:%s\n' "$package"; fi ;;
      'pm path '*) printf 'package:/data/app/~~fixture/%s-fixture/base.apk\n' "$package" ;;
      'cmd connectivity airplane-mode') cat airplane ;;
      'cmd connectivity airplane-mode enable') printf 'enabled\n' >airplane ;;
      'cmd connectivity airplane-mode disable') printf 'disabled\n' >airplane ;;
      'cmd wifi status') printf 'Wifi is %s\n' "$(cat wifi)" ;;
      'cmd wifi set-wifi-enabled '*) printf '%s\n' "$4" >wifi ;;
      'dumpsys connectivity')
        [[ $(cat airplane) == enabled && $(cat wifi) == disabled ]]
        printf 'Active default network: none\n' ;;
      'cmd package resolve-activity '*) printf '%s/.MainActivity\n' "$package" ;;
      'mktemp -d '*) printf '/data/local/tmp/crustcaper-smoke.Fixture1\n' ;;
      'input keyevent KEYCODE_WAKEUP'|'wm dismiss-keyguard'|'uiautomator dump '*|'rm -f '*|'rmdir '*) ;;
      'am force-stop '*) printf '0\n' >pid ;;
      'am start '*)
        runs=$(cat starts)
        printf '%s\n' "$((runs + 1))" >starts
        printf '%s\n' "$((600 + runs))" >pid
        printf 'Status: ok\nLaunchState: COLD\n' ;;
      'pidof '*)
        [[ $(cat pid) != 0 ]]
        if [[ $SMOKE_MOCK_SCENARIO == restart && -s samples ]]; then printf '700\n'; else cat pid; fi ;;
      *) printf 'Unexpected mock shell call: %s\n' "$*" >&2; exit 89 ;;
    esac ;;
  *) printf 'Unexpected mock adb call: %s\n' "$*" >&2; exit 89 ;;
esac
SH
chmod +x "$fixture/bin/"*

python3 - "$fixture/fixture.apk" <<'PY'
from zipfile import ZipFile
import sys

with ZipFile(sys.argv[1], "w") as archive:
    archive.writestr("assets/index.android.bundle", "synthetic fixture, not an APK")
PY

run_case() {
  local scenario=$1 profile=$2 evidence="$fixture/$1-$2" exit_status=0
  export SMOKE_MOCK_SCENARIO=$scenario SMOKE_MOCK_PROFILE=$profile
  : >"$fixture/commands"
  : >"$fixture/samples"
  printf 'disabled\n' >"$fixture/airplane"
  printf 'enabled\n' >"$fixture/wifi"
  printf '0\n' >"$fixture/pid"
  printf '0\n' >"$fixture/starts"

  bash "$root/tooling/android-emulator-smoke.sh" "$fixture/fixture.apk" "$profile" "$evidence" \
    >"$fixture/current.log" 2>&1 || exit_status=$?
  if [[ $scenario == good ]]; then
    if (( exit_status != 0 )); then cat "$fixture/current.log" >&2; return 1; fi
    grep -Fxq 'Result: passed' "$evidence/evidence.txt"
    [[ -s "$evidence/first-launch.xml" && -s "$evidence/second-launch.png" ]]
    [[ $(wc -l <"$fixture/samples") -eq 20 ]]
    [[ $(cat "$fixture/starts") == 2 ]]
  else
    if (( exit_status == 0 )); then cat "$fixture/current.log" >&2; return 1; fi
    [[ -s "$evidence/failure.txt" && ! -e "$evidence/evidence.txt" ]]
  fi
  [[ $(cat "$fixture/airplane") == disabled && $(cat "$fixture/wifi") == enabled && ! -e "$fixture/installed" ]]
  printf 'Mock Android smoke: %s %s\n' "$scenario" "$profile"
}

run_case good demo
run_case good stage
run_case physical demo
run_case reverse demo
run_case wrong-bytes demo
run_case lost-install-reply demo
run_case wrong-ui stage
run_case restart demo
printf 'Mock checks only. No emulator or APK was exercised.\n'
