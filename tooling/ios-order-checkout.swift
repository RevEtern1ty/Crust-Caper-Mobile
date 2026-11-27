import XCTest

final class CrustCaperCheckoutTests: XCTestCase {
    @MainActor
    func testPendingOrderSurvivesColdLaunchAndPaysOnce() throws {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "com.crustcaper.mobile.local")
        app.launch()

        let menuItem = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Double Smash,")).firstMatch
        // The connected menu arrives asynchronously after a cold launch.
        XCTAssertTrue(menuItem.waitForExistence(timeout: 30), "The connected menu must show Double Smash")
        menuItem.tap()
        try tap(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Add to cart ·")),
                named: "Add to cart", in: app)
        try tap(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "View cart ·")),
                named: "View cart", in: app)
        try tap(buttons(labeled: "Choose pickup time", in: app), named: "Choose pickup time", in: app)
        XCTAssertTrue(app.staticTexts["Pickup order"].waitForExistence(timeout: 12))
        try choosePickupSlot(in: app)

        try enterPhoneNumber(in: app)
        try enter("ios@example.test", in: "Email address", app: app)
        // The checkout scroll view dismisses the keyboard on a drag.
        if app.keyboards.firstMatch.exists {
            scrollDown(in: app)
        }
        try tap(buttons(labeled: "Review order", in: app), named: "Review order", in: app, scrolls: 2)
        XCTAssertTrue(app.staticTexts["Review your order"].waitForExistence(timeout: 15))
        try tap(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@ AND label ENDSWITH %@",
                                                 "Confirm ", "RWF & continue")),
                named: "Confirm quoted total", in: app)

        XCTAssertTrue(app.staticTexts["Checking payment"].waitForExistence(timeout: 20))
        let reference = app.staticTexts.matching(NSPredicate(format: "label MATCHES %@", "#[0-9A-F]{8}")).firstMatch
        XCTAssertTrue(reference.waitForExistence(timeout: 10), "The pending order must have a visible reference")
        let orderReference = reference.label
        capture("checkout-pending", app: app)

        app.terminate()
        XCTAssertTrue(app.wait(for: .notRunning, timeout: 10), "The application must stop before checkout recovery")
        app.launch()
        let ordersNavigation = app.descendants(matching: .any).matching(NSPredicate(
            format: "label == %@ OR label BEGINSWITH %@ OR label == %@", "Orders", "Orders,", "Go to Orders"
        ))
        try tap(ordersNavigation, named: "Orders navigation after relaunch", in: app)
        XCTAssertTrue(app.staticTexts[orderReference].waitForExistence(timeout: 20), "The same order must be restored")
        XCTAssertTrue(app.staticTexts["Checking payment"].waitForExistence(timeout: 12), "The restored order must still be unpaid")
        capture("checkout-recovered", app: app)

        try tap(buttons(labeled: "Open payment", in: app), named: "Open payment for the restored order", in: app, scrolls: 4)
        XCTAssertTrue(app.staticTexts[orderReference].waitForExistence(timeout: 12))
        try tap(buttons(labeled: "Confirm local test payment", in: app), named: "Confirm local test payment",
                in: app, scrolls: 4)
        XCTAssertTrue(app.staticTexts["Order accepted"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.staticTexts["Paid"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts[orderReference].exists, "Payment must settle the restored order")
        capture("checkout-accepted", app: app)
        let proof = XCTAttachment(string: "Order reference: \(orderReference)\nRecovery: same pending order after termination\nPayment: paid and accepted\n")
        proof.name = "checkout-reference"
        proof.lifetime = .keepAlways
        add(proof)
    }

    @MainActor
    private func enterPhoneNumber(in app: XCUIApplication) throws {
        let fields = app.textFields.matching(NSPredicate(format: "label == %@", "Phone number"))
        let field = try actionable(fields, named: "Phone number", in: app, scrolls: 5)
        field.tap()
        let keypad = app.keyboards.firstMatch
        XCTAssertTrue(keypad.waitForExistence(timeout: 8), "The phone keypad must open")

        // Bulk typeText on the phone pad lost part of this number on the hosted simulator.
        var entered = "+"
        field.typeText(entered)
        expectInput(entered, in: field, named: "Phone number")
        for digit in "250700000000" {
            let key = keypad.keys[String(digit)]
            XCTAssertTrue(key.exists, "The phone keypad must expose its numeric keys")
            key.tap()
            entered.append(digit)
            expectInput(entered, in: field, named: "Phone number")
        }
    }

    @MainActor
    private func choosePickupSlot(in app: XCUIApplication) throws {
        // The fresh fixture has 10-minute windows. The third available window leaves at least two full windows of lead time.
        let pattern = #"^\d{1,2}\s+\p{L}{3,5}\.?\s*·\s*\d{2}:\d{2}–\d{2}:\d{2}$"#
        let slots = app.descendants(matching: .any).matching(NSPredicate(format: "label MATCHES %@", pattern))
        XCTAssertTrue(slots.firstMatch.waitForExistence(timeout: 12), "The checkout must show available pickup windows")

        var observed = Set<String>()
        for pass in 0...4 {
            // Match the customer-visible date and time, independent of how UIKit bridges the radio role.
            for slot in slots.allElementsBoundByIndex where slot.isEnabled && slot.isHittable {
                if observed.insert(slot.label).inserted && observed.count == 3 {
                    slot.tap()
                    return
                }
            }
            if pass < 4 { scrollDown(in: app) }
        }
        XCTFail("The fixture must offer a tappable third pickup window")
    }

    @MainActor
    private func enter(_ text: String, in label: String, app: XCUIApplication) throws {
        let fields = app.textFields.matching(NSPredicate(format: "label == %@", label))
        let field = try actionable(fields, named: label, in: app, scrolls: 5)
        field.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 8), "The keyboard must open for \(label)")
        var entered = ""
        for character in text {
            field.typeText(String(character))
            entered.append(character)
            expectInput(entered, in: field, named: label)
        }
    }

    @MainActor
    private func expectInput(_ value: String, in field: XCUIElement, named label: String) {
        let expected = NSPredicate(format: "value == %@", value)
        let input = XCTNSPredicateExpectation(predicate: expected, object: field)
        XCTAssertEqual(XCTWaiter().wait(for: [input], timeout: 3), .completed,
                       "\(label) must retain all \(value.count) entered characters")
    }

    @MainActor
    private func buttons(labeled label: String, in app: XCUIApplication) -> XCUIElementQuery {
        app.buttons.matching(NSPredicate(format: "label == %@", label))
    }

    @MainActor
    private func tap(_ query: XCUIElementQuery, named label: String, in app: XCUIApplication, scrolls: Int = 0) throws {
        try actionable(query, named: label, in: app, scrolls: scrolls).tap()
    }

    @MainActor
    private func actionable(_ query: XCUIElementQuery, named label: String, in app: XCUIApplication,
                            scrolls: Int) throws -> XCUIElement {
        let first = query.firstMatch
        _ = first.waitForExistence(timeout: scrolls == 0 ? 15 : 3)
        for pass in 0...scrolls {
            if let match = query.allElementsBoundByIndex.first(where: { $0.isHittable && $0.isEnabled }) {
                return match
            }
            if pass < scrolls { scrollDown(in: app) }
        }
        let ready = NSPredicate(format: "hittable == true AND enabled == true")
        let expectation = XCTNSPredicateExpectation(predicate: ready, object: first)
        let match = XCTWaiter().wait(for: [expectation], timeout: 8) == .completed ? first : nil
        return try XCTUnwrap(match, "Could not interact with \(label)")
    }

    @MainActor
    private func scrollDown(in app: XCUIApplication) {
        let scrollView = app.scrollViews.firstMatch
        if scrollView.exists && scrollView.isHittable {
            scrollView.swipeUp()
        } else {
            app.swipeUp()
        }
    }

    @MainActor
    private func capture(_ name: String, app: XCUIApplication) {
        let snapshot = XCTAttachment(screenshot: app.screenshot())
        snapshot.name = name
        snapshot.lifetime = .keepAlways
        add(snapshot)
    }
}
