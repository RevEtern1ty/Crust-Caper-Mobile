# CrustCaper Mobile

A pickup-ordering demo for a restaurant in Kigali. Browse the menu, customise a burger, choose a pickup time and follow the order through payment and collection. The app supports English and Kinyarwanda and shows prices in Rwandan francs.

## Try the demo

Open the [Mobile CI runs](https://github.com/RevEtern1ty/Crust-Caper-Mobile/actions/workflows/mobile.yml) and choose a successful run. Its **Artifacts** section contains the downloads. GitHub requires a signed-in account to download them. If a download has expired, select a newer run or use the source instructions below.

**Windows browser.** Install [Node.js 24 LTS](https://nodejs.org/en/download/archive/v24). Download `mobile-web-preview-*`, choose **Extract All**, then double-click **Start_Demo.cmd** in the extracted folder. Open the local address shown in the window and leave that window open while trying the demo. If the archive contains only the exported website, use the source instructions below. The launcher needs no npm packages or API keys.

**Android phone.** Download `mobile-android-demo-*`, extract the ZIP, then transfer and open `app-release.apk` on an Android 9 or newer device. If Android prompts for permission to install this APK, follow the prompt for the app that opened it. The APK is debug-signed for demo use. The browser version is available if your device blocks sideloading.

### Place a demo order

1. Open **Double Smash**, add it to your cart, then open the cart and choose a pickup time.
2. Select **Use demo number** and review and confirm the order.
3. Select **Simulate successful payment** to open **Orders**.
4. Select **Simulate preparation** and **Simulate ready for pickup** to see the pickup code. You can also simulate a declined or pending payment and return to the current order.

The demo uses a synthetic menu and a local checkout adapter. Payment, preparation and pickup are simulated. There are no real charges or live restaurant orders.

## Run from source

On the [repository page](https://github.com/RevEtern1ty/Crust-Caper-Mobile), choose **Code → Download ZIP** and extract it. On Windows, open the extracted folder, type `cmd` in File Explorer’s address bar and press Enter. With Node.js 24 installed, run:

```sh
npm ci
npm run build:web
node tooling/preview-server.cjs dist
```

Open the address printed in the terminal. Dependency installation requires internet access. The demo runs on your computer after the export builds. For development use `npm run web`, `npm run android` or `npm run ios` with the relevant platform tools installed.

## How it was verified

The [recorded CI run](https://github.com/RevEtern1ty/Crust-Caper-Mobile/actions/runs/45699550622) passed lint, type checks, domain tests, browser checkout scenarios and dependency auditing. It built the Android demo APK and installed and launched the iOS demo on an iPhone 17 simulator running iOS 26.5. The Android checkout and recovery were also exercised on an Android 9 emulator. The iOS configuration targets iOS 16 and newer. The simulator check covers launch, and physical iPhone distribution is outside this demo.

```sh
npm run check
npm run build:web
npm run test:web
```

The browser tests use Chrome. See the [architecture](docs/architecture/MOBILE.md), [API contract](contracts/) and [release checks](docs/runbooks/MOBILE_RELEASE.md) for implementation and verification details.

## Connected release candidate

The mobile client and operator console share the [Spring Boot API](server/README.md). The `local` build profile connects to localhost and can be exercised end-to-end against PostgreSQL without charging a customer. The `stage` and `production` builds take their catalog, amount and payment status from the configured HTTPS API. See the [connected release procedure](docs/runbooks/CONNECTED_RELEASE.md).
