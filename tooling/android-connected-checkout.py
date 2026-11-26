#!/usr/bin/env python3
"""Run the synthetic pickup journey on one booted, dedicated Android emulator.

Use `python tooling/android-connected-checkout.py APK EVIDENCE_DIR --adb PATH`.
The local Release APK uses http://10.0.2.2:<api-port>/api/v1 by default.
Use --adb-reverse for APKs built with http://127.0.0.1:<api-port>/api/v1.
Use --upgrade-from OLD_APK for an in-place upgrade during a pending checkout.
Use --check-payment-return to open the native local return route after force-stop.
Use --late-receipt-pdf FIXTURE_PDF to attach a synthetic receipt after pickup.
Start the matching Spring Boot local API on the host loopback with a fresh test database.
"""

import argparse
from contextlib import closing
import hashlib
import http.client
import json
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
import uuid
import xml.etree.ElementTree as ET
import zipfile


PACKAGE = "com.crustcaper.mobile.local"
BOUNDS = re.compile(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]")
REFERENCE = re.compile(r"#[0-9A-F]{8}")
PICKUP_CODE = re.compile(r"[0-9]{6}")


class SmokeFailure(Exception):
    pass


def require(condition, message):
    if not condition:
        raise SmokeFailure(message)


def run_command(args, description, timeout=12):
    try:
        return subprocess.run(args, capture_output=True, check=True, timeout=timeout).stdout
    except (OSError, subprocess.SubprocessError):
        # Do not copy command lines or subprocess output into evidence.
        raise SmokeFailure(f"{description} failed") from None


def text(raw):
    return raw.decode("utf-8", errors="replace").replace("\r\n", "\n").strip()


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def find_aapt(adb):
    executable = "aapt.exe" if sys.platform == "win32" else "aapt"
    tools = Path(adb).resolve().parent.parent / "build-tools"
    versions = [path for path in tools.glob("*") if re.fullmatch(r"\d+\.\d+\.\d+", path.name)]
    versions.sort(key=lambda path: tuple(map(int, path.name.split("."))), reverse=True)
    return next((str(path / executable) for path in versions if (path / executable).is_file()),
                shutil.which(executable))


def apk_signers(apk, aapt):
    executable = "apksigner.bat" if sys.platform == "win32" else "apksigner"
    sibling = Path(aapt).resolve().with_name(executable)
    signer = str(sibling) if sibling.is_file() else shutil.which(executable)
    require(signer, "Place apksigner alongside aapt or on PATH for upgrade verification")
    signature = text(run_command([signer, "verify", "--print-certs", str(apk)], "Verify APK signature"))
    certificates = re.findall(
        r"^Signer #[0-9]+ certificate SHA-256 digest: ([0-9a-f]{64})$", signature, re.MULTILINE | re.IGNORECASE
    )
    require(certificates, "Could not read the APK signing certificates")
    return sorted(certificate.lower() for certificate in certificates)


def verify_apk(apk, aapt, port, *, api_host="10.0.2.2"):
    badging = text(run_command([aapt, "dump", "badging", str(apk)], "Read APK manifest"))
    require(f"package: name='{PACKAGE}'" in badging, "Expected the CrustCaper Local application ID")
    require("application-debuggable" not in badging, "Expected a non-debuggable Release APK")
    try:
        with zipfile.ZipFile(apk) as archive:
            bundle_size = archive.getinfo("assets/index.android.bundle").file_size
            config = json.loads(archive.read("assets/app.config"))
            restaurant = config["extra"]["restaurant"]
    except (KeyError, TypeError, ValueError, OSError, zipfile.BadZipFile):
        raise SmokeFailure("Cannot read the embedded APK configuration and bundle") from None
    require(bundle_size > 0, "APK must contain JavaScript for startup without Metro")
    if isinstance(restaurant, dict) and restaurant.get("webCheckout") is False:
        restaurant.pop("webCheckout")
    require(restaurant == {
        "profile": "local",
        "apiBaseUrl": f"http://{api_host}:{port}/api/v1",
        "storeId": "kigali",
        "pspHosts": [],
    }, "APK must point to the matching local emulator API fixture")
    return {"apkSha256": sha256(apk), "apkBytes": apk.stat().st_size, "bundleBytes": bundle_size}


class LocalApi:
    def __init__(self, origin):
        url = urllib.parse.urlsplit(origin)
        require(url.scheme == "http" and url.hostname in ("127.0.0.1", "localhost")
                and url.port and url.path == "/api/v1"
                and not (url.username or url.password or url.query or url.fragment),
                "The test API must use http://127.0.0.1:<port>/api/v1")
        self.host, self.port = url.hostname, url.port

    def request(self, method, route, status, *, token=None, data=None, headers=None):
        headers = {"Accept": "application/json", **(headers or {})}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        if data is not None and not isinstance(data, bytes):
            headers["Content-Type"] = "application/json"
            data = json.dumps(data)
        try:
            with closing(http.client.HTTPConnection(self.host, self.port, timeout=8)) as connection:
                connection.request(method, route, data, headers)
                response = connection.getresponse()
                require(response.status == status, f"Unexpected response in {method} {route.split('/')[-1]}: {response.status}")
                return None if status == 204 else json.loads(response.read())
        except (OSError, ValueError, http.client.HTTPException):
            raise SmokeFailure(f"The isolated API did not answer {method} {route.split('/')[-1]}") from None

    def check_ready(self):
        require(self.request("GET", "/actuator/health/readiness", 200).get("status") == "UP",
                "The test API is not ready")

    def login(self, username, role):
        body = self.request("POST", "/api/v1/operator/sessions", 201,
                            data={"username": username, "password": "local-demo-passphrase"})
        require(body.get("storeId") == "kigali" and body.get("role") == role and body.get("accessToken"),
                "Expected a synthetic operator session for the fixture store")
        return body["accessToken"]

    def queue(self, token):
        return self.request("GET", "/api/v1/operator/orders", 200, token=token)["orders"]

    def change(self, order_id, status, token, pickup_code=None):
        data = {"status": status}
        if pickup_code:
            data["pickupCode"] = pickup_code
        order = self.request("POST", f"/api/v1/operator/orders/{order_id}/status", 200, token=token, data=data)
        require(order.get("id") == order_id and order.get("status") == status and order.get("paymentStatus") == "paid",
                f"The operator did not confirm {status} for the fixture order")

    def logout(self, token):
        self.request("DELETE", "/api/v1/operator/sessions/current", 204, token=token)

    def attach_late_receipt(self, order_id, manager, pdf):
        matches = self.request("GET", f"/api/v1/operator/receipts?orderCode={order_id}", 200, token=manager)
        require(len(matches) == 1, "Expected one fiscal receipt entry for the fixture order")
        order = matches[0]
        require(order.get("orderId") == order_id and order.get("status") == "collected"
                and order.get("receiptStatus") == "pending" and order.get("currency") == "RWF",
                "The receipt must still be pending after pickup")
        reference = "ANDROID-TEST-" + order_id[-8:].upper()
        issued = self.request("PUT", f"/api/v1/operator/orders/{order_id}/receipt", 200, token=manager,
                              data=pdf, headers={"Content-Type": "application/pdf",
                                                 "X-Receipt-Reference": reference,
                                                 "X-Receipt-Total-RWF": str(order["total"])})
        require(issued.get("orderId") == order_id and issued.get("status") == "collected"
                and issued.get("receiptStatus") == "issued" and issued.get("receiptReference") == reference,
                "The manager did not attach the fixture receipt after pickup")


def box(node):
    match = BOUNDS.fullmatch(node.get("bounds", ""))
    if match:
        x, y, right, bottom = map(int, match.groups())
        if right > x and bottom > y:
            return x, y, right, bottom
    return None


def names(node):
    return node.get("text", ""), node.get("content-desc", "")


class Emulator:
    def __init__(self, adb):
        self.adb = adb
        lines = text(run_command([adb, "devices"], "List ADB devices")).splitlines()
        devices = [line.split() for line in lines[1:] if line.strip()]
        require(len(devices) == 1 and len(devices[0]) == 2 and devices[0][1] == "device"
                and re.fullmatch(r"emulator-\d+", devices[0][0]), "Expected exactly one online emulator")
        self.serial = devices[0][0]
        self.install_attempted = False
        self.remote_dir = None
        self.component = None
        self.reverse_port = None
        self.pids = []
        require(text(self.shell("getprop", "ro.kernel.qemu")) == "1"
                or text(self.shell("getprop", "ro.boot.qemu")) == "1", "Expected an Android emulator build")
        require(text(self.shell("getprop", "sys.boot_completed")) == "1", "The emulator has not finished booting")
        require(text(self.shell("am", "get-current-user")) == "0", "Expected the emulator owner profile")
        self.api_level = text(self.shell("getprop", "ro.build.version.sdk"))
        require(self.api_level.isdecimal() and int(self.api_level) >= 28, "Android 9 or newer is required")
        require(not self.reverse_mappings(), "Expected an emulator with no preexisting ADB reverse mappings")
        require(not self.package_installed(), "CrustCaper Local is already installed. Use a fresh emulator")

    def adb_run(self, *args, timeout=12):
        operation = " ".join(args[:2]) if args[0] == "shell" else args[0]
        return run_command([self.adb, "-s", self.serial, *map(str, args)], f"ADB {operation}", timeout)

    def shell(self, *args, timeout=12):
        return self.adb_run("shell", *args, timeout=timeout)

    def package_installed(self):
        packages = text(self.shell("pm", "list", "packages", "--user", "0", PACKAGE)).splitlines()
        return f"package:{PACKAGE}" in packages

    def reverse_mappings(self):
        records = [line.split() for line in text(self.adb_run("reverse", "--list")).splitlines() if line.strip()]
        require(all(len(record) in (2, 3) for record in records), "Could not identify ADB reverse mappings")
        return [tuple(record[-2:]) for record in records]

    def connect_loopback(self, port):
        require(not self.reverse_mappings(), "Expected an emulator with no preexisting ADB reverse mappings")
        endpoint = f"tcp:{port}"
        # ADB can apply the route before the host command receives its reply.
        self.reverse_port = endpoint
        self.adb_run("reverse", "--no-rebind", endpoint, endpoint)
        require(self.reverse_mappings() == [(endpoint, endpoint)], "Could not verify the checkout ADB reverse mapping")

    def disconnect_loopback(self):
        if not self.reverse_port:
            return
        endpoint = self.reverse_port
        routes = self.reverse_mappings()
        if (endpoint, endpoint) in routes:
            self.adb_run("reverse", "--remove", endpoint)
        require(not any(device == endpoint for device, _ in self.reverse_mappings()),
                "Could not remove the task-owned ADB reverse mapping")
        self.reverse_port = None

    def install(self, apk, expected_hash, *, replace=False):
        if replace:
            require(self.install_attempted and self.package_installed(),
                    "An in-place upgrade requires the installed fixture app")
        options = ["-r"] if replace else []
        self.install_attempted = True
        result = text(self.adb_run("install", *options, str(apk), timeout=120))
        require("Success" in result.splitlines() and self.package_installed(), "Failed to install the fixture APK")
        path = text(self.shell("pm", "path", "--user", "0", PACKAGE))
        match = re.fullmatch(r"package:(/data/app/[A-Za-z0-9_./=~+-]+/base\.apk)", path)
        require(match is not None, "Could not find a single installed base APK")
        with tempfile.TemporaryDirectory(prefix="crustcaper-apk-") as directory:
            installed = Path(directory) / "installed.apk"
            self.adb_run("pull", match[1], str(installed), timeout=45)
            require(sha256(installed) == expected_hash, "Installed app bytes differ from the tested APK")
        launcher = text(self.shell("cmd", "package", "resolve-activity", "--brief", "--user", "0",
                                   "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER",
                                   "-p", PACKAGE))
        component = launcher.splitlines()[-1] if launcher else ""
        require(re.fullmatch(re.escape(PACKAGE) + r"/[A-Za-z0-9_.]+", component),
                "Could not resolve the launcher belonging to CrustCaper Local")
        self.component = component
        if not self.remote_dir:
            directory = text(self.shell("mktemp", "-d", "/data/local/tmp/crustcaper-connected.XXXXXXXX"))
            require(re.fullmatch(r"/data/local/tmp/crustcaper-connected\.[A-Za-z0-9]+", directory),
                    "Could not allocate a private emulator scratch directory")
            self.remote_dir = directory

    def cleanup(self):
        try:
            try:
                if self.remote_dir:
                    # The UiAutomator dump may contain fixture contact or pickup code.
                    self.shell("rm", "-f", self.remote_dir + "/window.xml")
                    self.shell("rmdir", self.remote_dir)
            finally:
                if self.install_attempted and self.package_installed():
                    self.adb_run("uninstall", PACKAGE, timeout=20)
                    require(not self.package_installed(), "Could not remove the task-owned APK")
        finally:
            self.disconnect_loopback()

    def _launch_cold(self, *intent):
        self.shell("input", "keyevent", "KEYCODE_WAKEUP")
        self.shell("wm", "dismiss-keyguard")
        self.shell("am", "force-stop", "--user", "0", PACKAGE)
        response = text(self.shell("am", "start", "-W", "--user", "0", *intent, timeout=30))
        require(re.search(r"^Status:\s+ok$", response, re.MULTILINE), "Cold launch did not complete")
        pid = text(self.shell("pidof", PACKAGE))
        require(pid.isdecimal() and pid not in self.pids, "Cold launch did not start a new app process")
        self.pids.append(pid)

    def launch(self):
        self._launch_cold("-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", "-n", self.component)

    def launch_payment_return(self, order_id, claimed_status):
        query = urllib.parse.urlencode({"orderId": str(uuid.UUID(order_id)), "status": claimed_status})
        uri = "crustcaper-local://payment-return?" + query
        # adb passes the command through Android's shell, where the query separator needs quoting.
        self._launch_cold("-a", "android.intent.action.VIEW", "-c", "android.intent.category.BROWSABLE",
                          "-d", shlex.quote(uri), "-p", PACKAGE)

    def tree(self):
        path = self.remote_dir + "/window.xml"
        self.shell("rm", "-f", path)
        try:
            self.shell("uiautomator", "dump", path, timeout=10)
            return ET.fromstring(self.adb_run("exec-out", "cat", path))
        except (ET.ParseError, SmokeFailure):
            # Android window transitions can briefly leave no stable hierarchy.
            return ET.Element("hierarchy")

    def app_nodes(self, tree):
        return [node for node in tree.iter("node") if node.get("package") == PACKAGE and box(node)]

    def await_nodes(self, description, match, *, timeout=20, scroll=None):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            tree = self.tree()
            nodes = self.app_nodes(tree)
            result = match(nodes)
            if result is not None and result is not False:
                return result
            if scroll:
                self.scroll(nodes, scroll)
            time.sleep(0.3)
        raise SmokeFailure(f"Did not find {description} in the CrustCaper Local UI")

    def scroll(self, nodes, direction):
        candidates = [box(node) for node in nodes if node.get("scrollable") == "true"]
        if not candidates:
            return
        left, top, right, bottom = max(candidates, key=lambda region: region[3] - region[1])
        x = (left + right) // 2
        start, end = top + (bottom - top) * 4 // 5, top + (bottom - top) // 4
        if direction == "up":
            start, end = end, start
        self.shell("input", "swipe", x, start, x, end, "275")

    def tap(self, description, match, *, scroll=None, position=0):
        def matching_control(nodes):
            controls = [node for node in nodes
                        if node.get("clickable") == "true" and node.get("enabled") == "true" and match(node)]
            return controls[position] if position < len(controls) else None

        target = self.await_nodes(description, matching_control, scroll=scroll)
        left, top, right, bottom = box(target)
        self.shell("input", "tap", (left + right) // 2, (top + bottom) // 2)

    def tap_label(self, pattern, *, scroll=None):
        query = re.compile(pattern)
        self.tap(pattern, lambda node: any(query.fullmatch(name) for name in names(node)), scroll=scroll)

    def wait_label(self, label, *, scroll=None, timeout=20):
        self.await_nodes(label, lambda nodes: any(label in names(node) for node in nodes),
                         timeout=timeout, scroll=scroll)

    def matching_label(self, regex, description, *, scroll=None):
        return self.await_nodes(description, lambda nodes: next((
            name for node in nodes for name in names(node) if regex.fullmatch(name)
        ), None), scroll=scroll)

    def type_field(self, label, placeholder, value):
        self.tap(label, lambda node: node.get("class") == "android.widget.EditText"
                 and any(name in (label, placeholder) for name in names(node)), scroll="down")
        require(re.fullmatch(r"[0-9A-Za-z@.+-]+", value), "Unsafe synthetic input")
        self.shell("input", "text", value)
        ime = text(self.shell("dumpsys", "input_method"))
        if re.search(r"\b(?:mInputShown|mIsInputViewShown)=true\b", ime):
            self.shell("input", "keyevent", "KEYCODE_BACK")

    def capture(self, path):
        png = self.adb_run("exec-out", "screencap", "-p")
        require(png[:8] == b"\x89PNG\r\n\x1a\n", "Could not capture the app screen")
        path.write_bytes(png)

    def collected(self, reference, old_code):
        def is_collected(nodes):
            labels = {name for node in nodes for name in names(node)}
            return {"Picked up", "Paid", reference} <= labels and not {"Pickup code", old_code} & labels

        self.await_nodes("the same paid, collected order without a pickup code", is_collected)

    def wait_returned_payment(self, reference, expected, forbidden):
        def verified(nodes):
            labels = {label for node in nodes for label in names(node)}
            return {"Orders", reference, expected} <= labels and forbidden not in labels

        self.await_nodes("the returned order with its server-confirmed payment state", verified, scroll="up")


def checkout(args, evidence):
    api = LocalApi(args.api)
    aapt = args.aapt or find_aapt(args.adb)
    require(aapt, "Specify --aapt or put Android SDK build-tools next to --adb")
    api_host = "127.0.0.1" if args.adb_reverse else "10.0.2.2"
    summary = verify_apk(args.apk, aapt, api.port, api_host=api_host)
    previous = None
    if args.upgrade_from:
        previous = verify_apk(args.upgrade_from, aapt, api.port, api_host=api_host)
        require(previous["apkSha256"] != summary["apkSha256"], "The previous APK must differ from the candidate APK")
        certificates = apk_signers(args.upgrade_from, aapt)
        require(certificates == apk_signers(args.apk, aapt), "The previous and candidate APKs must have the same signing certificates")
        summary["upgradeFrom"] = {**previous, "signingCertificatesSha256": certificates}
    api.check_ready()
    device = Emulator(args.adb)
    sessions = []
    try:
        if args.adb_reverse:
            device.connect_loopback(api.port)
        kitchen = api.login("demo-kitchen", "kitchen")
        sessions.append(kitchen)
        pickup = api.login("demo-pickup", "pickup")
        sessions.append(pickup)
        require(not api.queue(kitchen), "Use a fresh fixture database with an empty paid kitchen queue")

        if previous:
            print("Install and launch the previous local APK", flush=True)
            device.install(args.upgrade_from, previous["apkSha256"])
        else:
            print("Install and launch the exact local APK", flush=True)
            device.install(args.apk, summary["apkSha256"])
        device.launch()
        device.wait_label("CrustCaper")
        device.matching_label(re.compile(r"Double Smash, .+"), "the Double Smash menu item")
        device.capture(evidence / "menu.png")
        device.tap_label(r"Double Smash, .+")
        device.tap_label(r"Add to cart · .+")
        device.tap_label(r"View cart · .+")
        device.tap_label("Choose pickup time")
        device.wait_label("Pickup time")
        # The first local window can close while the emulator enters contact details.
        device.tap("the third available pickup time", lambda node: node.get("class") == "android.widget.RadioButton",
                   scroll="down", position=2)
        device.type_field("Phone number", "+250 …", "+250700000000")
        device.type_field("Email address", "Email address", "native-checkout@example.test")
        device.tap_label("Review order")
        device.wait_label("Review your order")
        device.tap_label(r"Confirm .+ RWF & continue")
        device.wait_label("Checking payment")
        reference = device.matching_label(REFERENCE, "the pending order reference")

        if previous:
            device.capture(evidence / "pending-before-upgrade.png")
            print("Install the exact candidate over the pending checkout", flush=True)
            device.install(args.apk, summary["apkSha256"], replace=True)
        print("Restore the same pending order after a cold launch", flush=True)
        if args.check_payment_return:
            print("Open a local return claiming success for an unknown order", flush=True)
            device.launch_payment_return("00000000-1111-2222-3333-444444444444", "successful")
            device.wait_returned_payment(reference, "Checking payment", "Paid")
            require(not api.queue(kitchen), "An unverified return added an order to the kitchen queue")
            device.capture(evidence / "return-kept-payment-pending.png")
        else:
            device.launch()
            device.tap_label("Orders")
            device.wait_label(reference)
            device.wait_label("Checking payment")
        if previous:
            device.capture(evidence / "pending-after-upgrade.png")
        device.tap_label("Open payment", scroll="down")
        device.wait_label(reference)
        device.tap_label("Confirm local test payment", scroll="down")
        device.wait_label("Order accepted", scroll="up")
        device.wait_label(reference)

        queue = api.queue(kitchen)
        require(len(queue) == 1, "Payment did not create exactly one visible kitchen order")
        order = queue[0]
        order_id = str(uuid.UUID(order["id"]))
        require("#" + order_id[-8:].upper() == reference and order.get("status") == "accepted"
                and order.get("paymentStatus") == "paid", "The native order and paid kitchen order do not match")
        if args.check_payment_return:
            print("Open a local return claiming failure for the verified paid order", flush=True)
            device.launch_payment_return(order_id, "failed")
            device.wait_returned_payment(reference, "Paid", "Payment declined")
            confirmed = api.queue(kitchen)
            require(len(confirmed) == 1 and confirmed[0].get("id") == order_id
                    and confirmed[0].get("status") == "accepted" and confirmed[0].get("paymentStatus") == "paid",
                    "A return changed the verified paid kitchen order")
            device.capture(evidence / "return-kept-payment-paid.png")
        api.change(order_id, "preparing", kitchen)
        api.change(order_id, "ready", kitchen)
        device.wait_label("Ready for pickup")
        device.wait_label("Pickup code", scroll="down")
        code = device.matching_label(PICKUP_CODE, "the synthetic pickup code", scroll="down")
        device.wait_label(reference, scroll="up")

        print("Complete pickup and verify that the code disappears without a refresh", flush=True)
        api.change(order_id, "collected", pickup, code)
        device.collected(reference, code)
        require(not api.queue(kitchen), "The collected order remains in the active kitchen queue")
        device.capture(evidence / "collected.png")
        if args.late_receipt_pdf:
            device.wait_label("The receipt is pending.", scroll="down")
            manager = api.login("demo-manager", "manager")
            sessions.append(manager)
            api.attach_late_receipt(order_id, manager, args.late_receipt_pdf.read_bytes())
            print("The manager attached a receipt after pickup. Wait for the share action without refreshing", flush=True)
            device.wait_label("Share receipt", scroll="down", timeout=35)
            device.capture(evidence / "receipt-after-pickup.png")
        device.launch()
        device.tap_label("Orders")
        device.collected(reference, code)
        checks = ["exact installed APK", "same pending order after force-stop", "synthetic payment",
                  "paid kitchen order", "ready and collected updates without refresh", "collected order after force-stop"]
        if args.check_payment_return:
            summary["paymentReturnTransport"] = "Android VIEW intent for the local app scheme"
            checks.extend(["an unknown successful return reopens the original pending order without an accepted payment",
                           "a failed return leaves the verified original order paid and unique in the kitchen queue"])
        if args.late_receipt_pdf:
            checks.append("late receipt appeared after pickup without a manual refresh")
        if previous:
            checks.insert(1, "in-place upgrade preserved the pending checkout and authorized order access")
        if args.adb_reverse:
            checks.insert(1, "local checkout through the task-owned ADB reverse mapping")
        if args.check_session_end:
            print("End the guest session and verify cleared order access after a cold launch", flush=True)
            device.tap_label("Settings", scroll="up")
            device.wait_label("Order access")
            device.tap_label("End guest session", scroll="down")
            device.tap_label("Confirm end session", scroll="down")
            device.wait_label("Order access was cleared on this device.")
            device.capture(evidence / "session-ended.png")
            device.launch()
            device.tap_label("Orders")
            device.wait_label("No orders yet")
            checks.append("guest session ended and order access cleared after force-stop")
        summary.update({
            "profile": "local",
            "androidApi": int(device.api_level),
            "apiTransport": "adb-reverse" if args.adb_reverse else "emulator-host-alias",
            "emulator": device.serial,
            "orderReference": reference,
            "coldLaunchPids": list(map(int, device.pids)),
            "result": "passed",
            "checks": checks,
        })
        return summary
    finally:
        try:
            device.cleanup()
        finally:
            for token in sessions:
                try:
                    api.logout(token)
                except SmokeFailure:
                    print("Could not revoke a task-owned fixture operator session", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", type=lambda path: Path(path).resolve())
    parser.add_argument("evidence", type=lambda path: Path(path).resolve())
    parser.add_argument("--api", default="http://127.0.0.1:18080/api/v1")
    parser.add_argument("--adb", default=shutil.which("adb") or "adb")
    parser.add_argument("--aapt")
    parser.add_argument("--upgrade-from", type=lambda path: Path(path).resolve(), metavar="OLD_APK",
                        help="Preserve a pending checkout when installing the candidate over this local APK")
    parser.add_argument("--adb-reverse", action="store_true",
                        help="Use a local APK built for 127.0.0.1 and map the API port on the dedicated emulator")
    parser.add_argument("--check-session-end", action="store_true",
                        help="End the guest session on builds with the order-access settings screen")
    parser.add_argument("--check-payment-return", action="store_true",
                        help="Cold-launch the local app from payment return intents with conflicting result claims")
    parser.add_argument("--late-receipt-pdf", type=Path, metavar="FIXTURE_PDF",
                        help="Attach a synthetic receipt after pickup while the customer view stays open")
    args = parser.parse_args()

    try:
        require(args.apk.is_file(), "The APK must be an existing file")
        if args.upgrade_from:
            require(args.upgrade_from.is_file(), "The previous APK must be an existing file")
        if args.late_receipt_pdf:
            require(args.late_receipt_pdf.is_file() and 0 < args.late_receipt_pdf.stat().st_size <= 1024 * 1024,
                    "Use an existing synthetic receipt PDF of at most one MiB")
        args.evidence.mkdir(parents=True, exist_ok=True)
        require(not any(args.evidence.iterdir()), "Use an empty evidence directory")
    except (OSError, SmokeFailure) as error:
        print(str(error), file=sys.stderr)
        return 1

    try:
        result = checkout(args, args.evidence)
    except (KeyError, TypeError, OSError, ValueError, KeyboardInterrupt, SmokeFailure) as error:
        message = str(error) if isinstance(error, SmokeFailure) else type(error).__name__
        (args.evidence / "evidence.json").write_text(json.dumps({
            "result": "failed", "reason": message,
        }, indent=2) + "\n", encoding="utf-8")
        print(message, file=sys.stderr)
        return 1
    (args.evidence / "evidence.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print("Connected Android checkout passed", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
