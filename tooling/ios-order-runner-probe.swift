import XCTest

final class CrustCaperRunnerProbeTests: XCTestCase {
    @MainActor
    func testSettingsIsAccessible() {
        let settings = XCUIApplication(bundleIdentifier: "com.apple.Preferences")
        settings.launch()
        defer { settings.terminate() }

        XCTAssertTrue(settings.cells.firstMatch.waitForExistence(timeout: 15),
                      "XCTest must be able to inspect the Settings list")
    }
}
