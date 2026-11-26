#!/usr/bin/env python3
"""Verify order privacy on the exact local APK and a booted, dedicated Android emulator.

Use a fresh synthetic Spring local API with local phone verification. Point
ADB_SERVER_SOCKET at the task-owned loopback ADB server before running this file.
"""

import argparse
from contextlib import closing
import http.client
from importlib.util import module_from_spec, spec_from_file_location
import json
import os
from pathlib import Path
import re
import shutil
import socket
import sys
import time
import uuid


spec = spec_from_file_location("android_connected_checkout", Path(__file__).with_name("android-connected-checkout.py"))
smoke = module_from_spec(spec)
spec.loader.exec_module(smoke)

PHONE = "+250700000000"
EMAIL = "native-privacy@example.test"
CODE = "418263"
CHOOSER = re.compile(r"(?:android|com\.android\.intentresolver)/[\w.$]*ChooserActivity(?:Launcher)?")
ACTIVE = re.compile(r"(topResumedActivity|mResumedActivity)\s*[:=].*?\bu0\s+([\w.]+/[\w.$]+)")
API = "/api/v1"


def known_uuid(value, description):
    try:
        identifier = str(uuid.UUID(value))
    except (ValueError, TypeError, AttributeError):
        raise smoke.SmokeFailure(f"Missing or invalid {description}") from None
    smoke.require(identifier == value, f"Noncanonical {description}")
    return identifier


def require_dedicated_adb():
    address = re.fullmatch(r"tcp:127\.0\.0\.1:([1-9][0-9]{0,4})", os.environ.get("ADB_SERVER_SOCKET", ""))
    smoke.require(address and 1024 <= int(address[1]) <= 65535 and int(address[1]) != 5037,
                  "Expected the dedicated, non-default loopback ADB server in ADB_SERVER_SOCKET")
    try:
        with socket.create_connection(("127.0.0.1", int(address[1])), timeout=3):
            pass
    except OSError:
        raise smoke.SmokeFailure("The dedicated ADB server is not listening") from None


class PrivacyApi(smoke.LocalApi):
    def keyed_post(self, route, description, token, data=None):
        headers = {"Accept": "application/json", "Authorization": "Bearer " + token,
                   "Idempotency-Key": str(uuid.uuid4())}
        if data is not None:
            headers["Content-Type"] = "application/json"
        try:
            with closing(http.client.HTTPConnection(self.host, self.port, timeout=8)) as connection:
                connection.request("POST", route, json.dumps(data) if data is not None else None, headers)
                response = connection.getresponse()
                smoke.require(response.status == 200, f"Fixture {description} was not accepted")
                body = response.read(1024 * 1024 + 1)
                smoke.require(len(body) <= 1024 * 1024, f"Fixture {description} returned an oversized response")
                return json.loads(body)
        except (OSError, ValueError, http.client.HTTPException):
            raise smoke.SmokeFailure(f"The isolated API did not answer fixture {description}") from None

    def seed(self, guest):
        token = guest["accessToken"]
        menu = self.request("GET", API + "/stores/kigali/menu", 200)
        smoke.require(menu.get("store", {}).get("id") == "kigali" and menu["store"].get("open") is True,
                      "The synthetic Kigali storefront is not accepting orders")
        product = next((item for item in menu["products"] if item.get("sku") == "double-smash" and item.get("available")), None)
        slot = next((item for item in reversed(menu["slots"]) if item.get("available")), None)
        smoke.require(product and slot, "The synthetic menu needs an available item and pickup window")
        quote = self.request("POST", API + "/quotes", 200, token=token, data={
            "storeId": "kigali", "slotId": slot["id"], "lines": [{"sku": product["sku"], "modifierIds": [],
                                                                 "quantity": 1, "unitPrice": product["price"]}],
        })
        quote_id = known_uuid(quote.get("quoteId"), "quote identity")
        order = self.keyed_post(API + "/orders", "order creation", token,
                                {"quoteId": quote_id, "phone": PHONE, "email": EMAIL})
        order_id = known_uuid(order.get("id"), "order identity")
        attempt = self.keyed_post(f"{API}/orders/{order_id}/payments", "payment opening", token)
        attempt_id = known_uuid(attempt.get("id"), "attempt identity")
        order = self.request("POST", f"{API}/local/orders/{order_id}/payments/{attempt_id}/result", 200,
                             token=token, data={"status": "paid"})
        assert_paid(order, order_id, attempt_id, quote["total"])
        return order_id, attempt_id, quote["total"]

    def erasure_requests(self, manager, status="pending"):
        return self.request("GET", f"{API}/operator/erasure-requests?status={status}", 200, token=manager)


def assert_paid(order, order_id, attempt_id, total):
    smoke.require(order.get("id") == order_id and order.get("status") == "accepted" and order.get("paymentStatus") == "paid"
                  and order.get("paymentAttempt", {}).get("id") == attempt_id and order.get("total") == total,
                  "The test checkout did not retain the same paid order and attempt")


def activity(device):
    records = smoke.text(device.shell("dumpsys", "activity", "activities"))
    activities = dict(ACTIVE.findall(records))
    return activities.get("topResumedActivity", activities.get("mResumedActivity"))


def wait_activity(device, predicate, description, timeout=18):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        current = activity(device)
        if current and predicate(current):
            return
        time.sleep(.3)
    raise smoke.SmokeFailure(f"Did not observe {description}")


def is_app(activity_name):
    return activity_name.startswith(smoke.PACKAGE + "/")


def resume_from_home(device):
    original_pid = smoke.text(device.shell("pidof", smoke.PACKAGE))
    smoke.require(original_pid.isdecimal(), "The fixture APK process was not running before backgrounding")
    device.shell("input", "keyevent", "KEYCODE_HOME")
    wait_activity(device, lambda name: not is_app(name), "the emulator home screen after backgrounding")
    response = smoke.text(device.shell("am", "start", "-W", "--user", "0", "-a", "android.intent.action.MAIN",
        "-c", "android.intent.category.LAUNCHER", "-n", device.component, timeout=30))
    smoke.require(re.search(r"^Status:\s+ok$", response, re.MULTILINE), "Did not resume the Android privacy screen")
    wait_activity(device, is_app, "the same app task after returning")
    smoke.require(smoke.text(device.shell("pidof", smoke.PACKAGE)) == original_pid,
                  "Returning from the home screen started a different app process")


def verify_cleared_code(device):
    def empty_input(nodes):
        return any(node.get("class") == "android.widget.EditText" and node.get("content-desc") == "Verification code"
                   and node.get("text", "") == "" for node in nodes)

    device.wait_label("Verify your phone")
    device.await_nodes("the same verification form with an empty code input", empty_input)


def cancel_share_sheet(device):
    device.tap_label("Share order data", scroll="up")
    try:
        wait_activity(device, lambda name: CHOOSER.fullmatch(name) is not None, "the Android share chooser")
    finally:
        current = activity(device)
        if current and CHOOSER.fullmatch(current):
            device.shell("input", "keyevent", "KEYCODE_BACK")
    wait_activity(device, is_app, "the original app after cancelling the share chooser")
    device.wait_label("Share order data", scroll="up")


def verify_review(api, token, order_id):
    matches = api.erasure_requests(token)
    smoke.require(isinstance(matches, list) and len(matches) == 1 and matches[0].get("orderId") == order_id,
                  "The submitted request did not match the only pending fixture order")
    pending = matches[0]
    smoke.require(pending.get("status") == "pending" and pending.get("reviewedAt") is None,
                  "The stored deletion request should be waiting for review")
    request_id = known_uuid(pending.get("requestId"), "deletion request identity")
    route = f"{API}/operator/erasure-requests/{request_id}/review"
    reviewed = api.request("POST", route, 200, token=token)
    replay = api.request("POST", route, 200, token=token)
    smoke.require(reviewed == replay and reviewed.get("requestId") == request_id and reviewed.get("orderId") == order_id
                  and reviewed.get("status") == "in_review" and reviewed.get("reviewedAt"),
                  "Repeating manager review changed the fixture request identity or review time")
    reviewed_rows = api.erasure_requests(token, "in_review")
    smoke.require(reviewed_rows == [reviewed] and api.erasure_requests(token) == [],
                  "Expected only one reviewed fixture request and no pending copy")


def capture_review_status(device, order_id, path):
    private_values = (PHONE, EMAIL, CODE, CODE[:4], order_id, order_id[-8:])

    def safe_status(nodes):
        labels = [label.casefold() for node in nodes for label in smoke.names(node)]
        return "in review" in labels and all(value.casefold() not in label for value in private_values for label in labels)

    device.await_nodes("the review status screen without fixture contacts, order number, or code", safe_status, scroll="down")
    device.capture(path)


def run(args, report):
    api = PrivacyApi(args.api)
    smoke.require(api.host == "127.0.0.1", "Use the literal host loopback address for the isolated API")
    aapt = args.aapt or smoke.find_aapt(args.adb)
    smoke.require(aapt, "Specify --aapt or place Android SDK build-tools next to --adb")
    api_host = "127.0.0.1" if args.adb_reverse else "10.0.2.2"
    apk = smoke.verify_apk(args.apk, aapt, api.port, api_host=api_host)
    if args.apk_sha256:
        smoke.require(apk["apkSha256"] == args.apk_sha256.lower(), "The candidate APK differs from the supplied fingerprint")
    report.update(apk, profile="local", apiTransport="adb-reverse" if args.adb_reverse else "emulator-host-alias")
    require_dedicated_adb()
    device = smoke.Emulator(args.adb)
    name = [line.strip() for line in smoke.text(device.adb_run("emu", "avd", "name")).splitlines() if line.strip()]
    smoke.require(device.serial == args.serial and name in ([args.avd_name], [args.avd_name, "OK"]),
                  "The connected emulator does not match the owned serial and AVD name")
    report.update(androidApi=int(device.api_level), emulator=device.serial, avd=args.avd_name)
    sessions = []
    guest = None
    try:
        api.check_ready()
        manager = api.login("demo-manager", "manager")
        sessions.append(manager)
        kitchen = api.login("demo-kitchen", "kitchen")
        sessions.append(kitchen)
        smoke.require(api.erasure_requests(manager) == [] and api.erasure_requests(manager, "in_review") == []
                      and api.queue(kitchen) == [], "The fixture needs an empty kitchen queue and no deletion requests")
        if args.adb_reverse:
            device.connect_loopback(api.port)
        report["phase"] = "seed_order"
        guest = api.request("POST", API + "/guest-sessions", 200)
        smoke.require(guest.get("accessToken") and guest.get("refreshToken"), "The synthetic guest session is missing")
        order_id, attempt_id, total = api.seed(guest)
        smoke.require([row.get("id") for row in api.queue(kitchen)] == [order_id], "The fixture order did not reach the kitchen")

        report["phase"] = "verify_otp"
        print("Verify the installed APK and open order privacy", flush=True)
        device.install(args.apk, apk["apkSha256"])
        report["exactInstalledApk"] = True
        device.launch()
        device.wait_label("CrustCaper")
        device.tap_label("Orders")
        device.tap_label("Settings")
        device.tap_label("Order privacy", scroll="down")
        device.wait_label("Order privacy")
        device.type_field("Order number", "#1A2B3C4D", order_id[-8:].upper())
        device.type_field("Phone number", "+250 …", PHONE)
        device.tap_label("Request verification code")
        device.wait_label("Verify your phone")
        device.type_field("Verification code", "", CODE[:4])
        device.await_nodes("partial code entered before backgrounding", lambda nodes: any(
            node.get("class") == "android.widget.EditText" and node.get("content-desc") == "Verification code"
            and node.get("text") == CODE[:4] for node in nodes))
        resume_from_home(device)
        verify_cleared_code(device)
        report["otpChallengeSurvivedBackground"] = True
        report["partialOtpCleared"] = True
        device.type_field("Verification code", "", CODE)
        device.tap_label("Verify and continue")
        device.wait_label("Share order data")
        report["realLocalOtpApproved"] = True

        report["phase"] = "submit_and_review"
        print("Submit the deletion request and verify its manager review", flush=True)
        device.tap_label("Request deletion", scroll="down")
        smoke.require(api.erasure_requests(manager) == [], "The confirmation screen wrote a request before consent")
        device.tap_label("Submit deletion request", scroll="down")
        device.wait_label("Pending review", scroll="down")
        verify_review(api, manager, order_id)
        report["oneRequestSubmitted"] = True
        report["managerReviewIdempotent"] = True
        device.tap_label("Check request status", scroll="down")
        capture_review_status(device, order_id, args.evidence / "privacy-in-review.png")
        report["customerReadsReviewedStatus"] = True
        report["privacyStatusScreenshotCaptured"] = True

        if args.check_share:
            report["phase"] = "share"
            print("Open and cancel the Android share chooser", flush=True)
            cancel_share_sheet(device)
            report["shareChooserOpenedAndCancelled"] = True

        report["phase"] = "postcheck"
        try:
            order = api.request("GET", f"{API}/orders/{order_id}", 200, token=guest["accessToken"])
        except smoke.SmokeFailure:
            raise smoke.SmokeFailure("Could not re-read the paid fixture order") from None
        assert_paid(order, order_id, attempt_id, total)
        smoke.require([row.get("id") for row in api.queue(kitchen)] == [order_id],
                      "The deletion request or export changed the paid kitchen record")
        report["paidOrderPreserved"] = True
        device.shell("input", "keyevent", "KEYCODE_BACK")
        device.wait_label("Order access", scroll="down")
        device.tap_label("End guest session", scroll="down")
        device.tap_label("Confirm end session", scroll="down")
        device.wait_label("Order access was cleared on this device.")
        report["deviceGuestSessionEnded"] = True
    finally:
        try:
            device.cleanup()
            report["ownedAppRemoved"] = True
        finally:
            failures = []
            for token in sessions:
                try:
                    api.logout(token)
                except smoke.SmokeFailure:
                    failures.append("operator")
            if guest and guest.get("refreshToken"):
                try:
                    api.request("POST", API + "/guest-sessions/revoke", 204, data={"refreshToken": guest["refreshToken"]})
                except smoke.SmokeFailure:
                    failures.append("seed guest")
            report["seedSessionsRevoked"] = not failures
            smoke.require(not failures, "Could not revoke all task-owned fixture sessions")
    report["phase"] = "complete"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", type=Path)
    parser.add_argument("evidence", type=Path)
    parser.add_argument("--adb", default=shutil.which("adb") or "adb")
    parser.add_argument("--aapt")
    parser.add_argument("--serial", required=True)
    parser.add_argument("--avd-name", required=True)
    parser.add_argument("--api", default="http://127.0.0.1:18080/api/v1")
    parser.add_argument("--apk-sha256")
    parser.add_argument("--adb-reverse", action="store_true")
    parser.add_argument("--check-share", action="store_true")
    args = parser.parse_args()
    if args.apk_sha256 and not re.fullmatch(r"[0-9a-fA-F]{64}", args.apk_sha256):
        parser.error("--apk-sha256 requires a SHA-256 fingerprint")
    if not args.apk.is_file():
        parser.error("The APK must be an existing file")
    args.apk = args.apk.resolve()
    args.evidence.mkdir(parents=True, exist_ok=True)
    if any(args.evidence.iterdir()):
        parser.error("Use an empty evidence directory")

    report = {"phase": "preflight", "passed": False, "shareChooserOpenedAndCancelled": False}
    try:
        run(args, report)
        report["passed"] = True
    except (smoke.SmokeFailure, KeyboardInterrupt) as error:
        report["failure"] = str(error) if isinstance(error, smoke.SmokeFailure) else "Interrupted"
    except (KeyError, TypeError, ValueError, OSError):
        report["failure"] = "Invalid fixture response or local runtime error"
    finally:
        (args.evidence / "evidence.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
