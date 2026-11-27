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
        XCTAssertTrue(text(labeled: "Pickup order", in: app).waitForExistence(timeout: 12))
        try choosePickupSlot(in: app)

        try enterPhoneNumber(in: app)
        try enter("ios@example.test", in: "Email address", app: app)
        // The checkout scroll view dismisses the keyboard on a drag.
        if app.keyboards.firstMatch.exists {
            scrollDown(in: app)
        }
        try tap(buttons(labeled: "Review order", in: app), named: "Review order", in: app, scrolls: 2)
        // The enabled confirmation button only appears once the server has returned the quote.
        try tap(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@ AND label ENDSWITH %@",
                                                 "Confirm ", "RWF & continue")),
                named: "Confirm quoted total", in: app)

        let pendingPayment = text(labeled: "Checking payment", in: app)
        XCTAssertTrue(pendingPayment.waitForExistence(timeout: 20))
        let reference = app.staticTexts.matching(NSPredicate(format: "label MATCHES %@", "#[0-9A-F]{8}")).firstMatch
        XCTAssertTrue(reference.waitForExistence(timeout: 10), "The pending order must have a visible reference")
        let orderReference = reference.label
        let sameOrder = text(labeled: orderReference, in: app)
        capture("checkout-pending", app: app)

        app.terminate()
        XCTAssertTrue(app.wait(for: .notRunning, timeout: 10), "The application must stop before checkout recovery")
        app.launch()
        let ordersNavigation = app.descendants(matching: .any).matching(NSPredicate(
            format: "label == %@ OR label BEGINSWITH %@ OR label == %@", "Orders", "Orders,", "Go to Orders"
        ))
        try tap(ordersNavigation, named: "Orders navigation after relaunch", in: app)
        XCTAssertTrue(sameOrder.waitForExistence(timeout: 20), "The same order must be restored")
        XCTAssertTrue(pendingPayment.waitForExistence(timeout: 12), "The restored order must still be unpaid")
        capture("checkout-recovered", app: app)

        try tap(buttons(labeled: "Open payment", in: app), named: "Open payment for the restored order", in: app, scrolls: 4)
        XCTAssertTrue(sameOrder.waitForExistence(timeout: 12))
        try tap(buttons(labeled: "Confirm local test payment", in: app), named: "Confirm local test payment",
                in: app, scrolls: 4)
        XCTAssertTrue(text(labeled: "Order accepted", in: app).waitForExistence(timeout: 20))
        XCTAssertTrue(text(labeled: "Paid", in: app).waitForExistence(timeout: 10))
        XCTAssertTrue(sameOrder.exists, "Payment must settle the restored order")
        capture("checkout-accepted", app: app)
        let proof = XCTAttachment(string: "Order reference: \(orderReference)\nRecovery: same pending order after termination\nPayment: paid and accepted\n")
        proof.name = "checkout-reference"
        proof.lifetime = .keepAlways
        add(proof)

        #if CRUSTCAPER_IOS_RECEIPT_SHARING
        try verifyDocumentSharing(for: orderReference, in: app)
        #endif
    }

    #if CRUSTCAPER_IOS_RECEIPT_SHARING
    @MainActor
    private func verifyDocumentSharing(for orderReference: String, in app: XCUIApplication) throws {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let files = XCUIApplication(bundleIdentifier: "com.apple.DocumentsApp")
        let shareRoots = [app, springboard]
        let fileRoots = [app, files, springboard]
        let receipt = buttons(labeled: "Share receipt", in: app)
        XCTAssertTrue(receipt.firstMatch.waitForExistence(timeout: 35), "The paid order must receive its fixture receipt")
        try tap(receipt, named: "Share receipt", in: app, scrolls: 5)
        try waitForShareSheet(in: shareRoots, phase: "receipt-first-share")

        let print = try systemAction(["Print"], in: shareRoots, phase: "receipt-print-action", scrolls: 3)
        print.tap()
        // An ordinary share-sheet Close button does not prove that Print opened.
        let printerControls = ["Print Options", "Printer Options", "Printer", "Select Printer", "No Printer Selected"]
        _ = try systemAction(printerControls, in: shareRoots, phase: "receipt-print-options", readOnly: true)
        captureSystemScreen("receipt-print-options")
        let cancelPrint = try systemAction(["Cancel", "Close"], in: shareRoots, phase: "receipt-print-cancel")
        cancelPrint.tap()
        let printDismissed = waitForSystemState(timeout: 10) {
            self.systemMatch(printerControls, in: shareRoots, requireAction: false) == nil
        }
        if !printDismissed {
            captureSystemDiagnostics("receipt-print-dismissal", in: shareRoots)
            XCTFail("The printer options must close after cancellation")
        }
        if !receipt.firstMatch.isHittable && systemMatch(["Save to Files", "Print"], in: shareRoots) != nil {
            try closeShareSheet(in: shareRoots, phase: "receipt-returned-share-sheet")
        }
        try tap(receipt, named: "Reopen the same receipt after cancelling Print", in: app, scrolls: 3)
        try saveToLocalFiles(from: shareRoots, pickerRoots: fileRoots, phase: "receipt")
        _ = try actionable(receipt, named: "Receipt action restored after Files", in: app, scrolls: 3)
        XCTAssertTrue(text(labeled: orderReference, in: app).exists)
        recordSharingProof("receipt-sharing", """
            Print options opened and cancelled.
            Reopened the same receipt and saved it through On My iPhone.
            Expected filename: receipt-\(orderReference.dropFirst().lowercased()).pdf
            """)

        let settings = buttons(labeled: "Settings", in: app)
        for _ in 0..<4 where !settings.firstMatch.isHittable {
            let scrollView = app.scrollViews.firstMatch
            (scrollView.isHittable ? scrollView : app).swipeDown()
        }
        try tap(settings, named: "Orders settings", in: app)
        try tap(buttons(labeled: "Order privacy", in: app), named: "Order privacy", in: app, scrolls: 4)
        try enter(String(orderReference.dropFirst()), in: "Order number", app: app)
        try enterPhoneNumber(in: app)
        if app.keyboards.firstMatch.exists { scrollDown(in: app) }
        try tap(buttons(labeled: "Request verification code", in: app), named: "Request verification code", in: app, scrolls: 2)
        try enterPrivacyCode(in: app)
        if app.keyboards.firstMatch.exists { scrollDown(in: app) }
        try tap(buttons(labeled: "Verify and continue", in: app), named: "Verify the original order", in: app, scrolls: 2)

        let orderData = buttons(labeled: "Share order data", in: app)
        try tap(orderData, named: "Share verified order data", in: app, scrolls: 3)
        try waitForShareSheet(in: shareRoots, phase: "order-data-first-share")
        captureSystemScreen("order-data-first-share")
        try closeShareSheet(in: shareRoots, phase: "order-data-cancel")
        try tap(orderData, named: "Reopen verified order data after cancelling", in: app, scrolls: 3)
        try saveToLocalFiles(from: shareRoots, pickerRoots: fileRoots, phase: "order-data")
        _ = try actionable(orderData, named: "Order data action restored after Files", in: app, scrolls: 3)
        recordSharingProof("order-data-sharing", """
            Verified the original order, opened and cancelled its export, then reopened it.
            Saved the export through On My iPhone.
            Expected filename: crustcaper-order-data.json
            """)
    }

    @MainActor
    private func enterPrivacyCode(in app: XCUIApplication) throws {
        let field = try actionable(app.textFields.matching(NSPredicate(format: "label == %@", "Verification code")),
                                   named: "Verification code", in: app, scrolls: 3)
        field.tap()
        let keypad = app.keyboards.firstMatch
        XCTAssertTrue(keypad.waitForExistence(timeout: 8), "The local fixture code must use the native keypad")
        var entered = ""
        for digit in "418263" {
            let key = keypad.keys[String(digit)]
            XCTAssertTrue(key.isHittable, "The verification keypad must expose its numeric keys")
            key.tap()
            entered.append(digit)
            expectInput(entered, in: field, named: "Verification code")
        }
    }

    @MainActor
    private func saveToLocalFiles(from shareRoots: [XCUIApplication], pickerRoots: [XCUIApplication],
                                  phase: String) throws {
        try waitForShareSheet(in: shareRoots, phase: "\(phase)-reopened-share")
        try systemAction(["Save to Files"], in: shareRoots, phase: "\(phase)-files-action", scrolls: 3).tap()
        _ = try systemAction(["Save"], in: pickerRoots, phase: "\(phase)-files-picker", readOnly: true)
        let folder = "On My iPhone"
        let folderQuery = NSPredicate(format: "label == %@ OR identifier == %@", folder, folder)
        func localFolderIsOpen() -> Bool {
            pickerRoots.contains { root in
                guard root === pickerRoots[0] || root.state == .runningForeground else { return false }
                return root.navigationBars.matching(folderQuery).firstMatch.exists
                    || root.navigationBars.descendants(matching: .staticText).matching(folderQuery).firstMatch.exists
            }
        }

        if !localFolderIsOpen() {
            if systemMatch([folder], in: pickerRoots) == nil {
                try systemAction(["Browse", "Locations", "Back"], in: pickerRoots,
                                 phase: "\(phase)-files-locations").tap()
            }
            try systemAction([folder], in: pickerRoots, phase: "\(phase)-files-local-location").tap()
        }
        if !waitForSystemState(timeout: 8, localFolderIsOpen) {
            captureSystemDiagnostics("\(phase)-files-local-folder", in: pickerRoots)
            XCTFail("The document picker must be in On My iPhone")
        }
        captureSystemScreen("\(phase)-files-local-folder")
        try systemAction(["Save"], in: pickerRoots, phase: "\(phase)-files-save").tap()
    }

    @MainActor
    private func closeShareSheet(in roots: [XCUIApplication], phase: String) throws {
        // The caller has already observed an activity belonging to the system share sheet.
        try systemAction(["Close", "Cancel", "Close Share Sheet"], in: roots, phase: phase).tap()
    }

    @MainActor
    private func waitForShareSheet(in roots: [XCUIApplication], phase: String) throws {
        _ = try systemAction(["Print", "Save to Files", "Copy", "AirDrop"], in: roots, phase: phase, readOnly: true)
    }

    @MainActor
    private func systemMatch(_ labels: [String], in roots: [XCUIApplication],
                             requireAction: Bool = true) -> XCUIElement? {
        let predicate = NSPredicate(format: "label IN %@ OR identifier IN %@ OR value IN %@",
                                    argumentArray: [labels, labels, labels])
        for root in roots where root === roots[0] || root.state == .runningForeground {
            let candidates = root.descendants(matching: .any).matching(predicate)
            if !requireAction, candidates.firstMatch.exists { return candidates.firstMatch }
            if let match = candidates.allElementsBoundByIndex.first(where: { $0.isHittable && $0.isEnabled }) {
                return match
            }
        }
        return nil
    }

    @MainActor
    private func systemAction(_ labels: [String], in roots: [XCUIApplication], phase: String,
                              scrolls: Int = 0, readOnly: Bool = false) throws -> XCUIElement {
        let app = roots[0]
        var result: XCUIElement?
        for pass in 0...scrolls {
            result = systemMatch(labels, in: roots, requireAction: !readOnly)
            if let result { return result }
            if pass < scrolls {
                let foreground = roots.dropFirst().first(where: { $0.state == .runningForeground }) ?? app
                if let collection = foreground.collectionViews.allElementsBoundByIndex.last(where: { $0.isHittable }) {
                    collection.swipeUp()
                } else {
                    foreground.swipeUp()
                }
            }
        }
        let found = waitForSystemState(timeout: 10) {
            result = self.systemMatch(labels, in: roots, requireAction: !readOnly)
            return result != nil
        }
        if !found { captureSystemDiagnostics(phase, in: roots) }
        return try XCTUnwrap(result, "Missing system control for \(phase): \(labels.joined(separator: " / "))")
    }

    @MainActor
    private func waitForSystemState(timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
        let deadline = ProcessInfo.processInfo.systemUptime + timeout
        repeat {
            if condition() { return true }
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.25))
        } while ProcessInfo.processInfo.systemUptime < deadline
        return false
    }

    @MainActor
    private func captureSystemDiagnostics(_ phase: String, in roots: [XCUIApplication]) {
        captureSystemScreen(phase)
        for root in roots where root === roots[0] || root.state == .runningForeground {
            let hierarchy = XCTAttachment(string: root.debugDescription)
            hierarchy.name = "\(phase)-accessibility"
            hierarchy.lifetime = .keepAlways
            add(hierarchy)
        }
    }

    @MainActor
    private func captureSystemScreen(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    @MainActor
    private func recordSharingProof(_ name: String, _ text: String) {
        let attachment = XCTAttachment(string: text)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
    #endif

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
    private func text(labeled label: String, in app: XCUIApplication) -> XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "label == %@", label)).firstMatch
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
