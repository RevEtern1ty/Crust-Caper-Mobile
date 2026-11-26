"""Regression tests for the locally installed Android checkout verifier."""

from importlib.util import module_from_spec, spec_from_file_location
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from zipfile import ZipFile


spec = spec_from_file_location("android_connected_checkout", Path(__file__).with_name("android-connected-checkout.py"))
checkout = module_from_spec(spec)
spec.loader.exec_module(checkout)


class VerifyApkTest(unittest.TestCase):
    def verify(self, overrides):
        restaurant = {
            "profile": "local",
            "apiBaseUrl": "http://127.0.0.1:18080/api/v1",
            "storeId": "kigali",
            "pspHosts": [],
            **overrides,
        }
        with TemporaryDirectory() as directory:
            apk = Path(directory) / "test.apk"
            with ZipFile(apk, "w") as archive:
                archive.writestr("assets/index.android.bundle", b"fixture")
                archive.writestr("assets/app.config", json.dumps({"extra": {"restaurant": restaurant}}))
            with patch.object(checkout, "run_command", return_value=b"package: name='com.crustcaper.mobile.local'"):
                return checkout.verify_apk(apk, "aapt", 18080, api_host="127.0.0.1")

    def test_accepts_legacy_profile_without_web_setting(self):
        self.assertEqual(self.verify({})["bundleBytes"], 7)

    def test_accepts_current_profile_with_web_checkout_disabled(self):
        self.assertEqual(self.verify({"webCheckout": False})["bundleBytes"], 7)

    def test_rejects_web_checkout_enabled_or_wrong_value_type(self):
        for value in (True, 0, None, "", "false"):
            with self.subTest(value=value), self.assertRaises(checkout.SmokeFailure):
                self.verify({"webCheckout": value})

    def test_still_rejects_a_different_api_or_extra_runtime_settings(self):
        for overrides in (
            {"apiBaseUrl": "http://127.0.0.1:18081/api/v1"},
            {"webCheckout": False, "pushProjectId": "unexpected"},
        ):
            with self.subTest(overrides=overrides), self.assertRaises(checkout.SmokeFailure):
                self.verify(overrides)


if __name__ == "__main__":
    unittest.main()
