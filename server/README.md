# CrustCaper API

The Spring Boot application serves the mobile checkout and the operator console. Java 21, Gradle, PostgreSQL 17 and Flyway are pinned in the source. The [shared HTTP contract](../contracts/README.md) documents the customer routes.

## Local integration

Start PostgreSQL and build the JAR from the repository root with Docker running.

```sh
docker compose --project-name crustcaper-mobile-api-local -f server/compose.local.yml up -d --wait
cd server
./gradlew test bootJar
```

Use `gradlew.bat` on Windows. The local stack uses a loopback-only PostgreSQL database and synthetic restaurant data. Set `CRUSTCAPER_BUILD_PROFILE=local` and `CRUSTCAPER_API_BASE_URL=http://127.0.0.1:18080/api/v1`, then run the connected app from the repository root.

For an existing PostgreSQL 17 installation, create a dedicated empty local test database and give its user permission to apply the CrustCaper migrations. Set `CRUSTCAPER_LOCAL_DB_MODE=existing` and provide `CRUSTCAPER_DB_URL`, `CRUSTCAPER_DB_USER` and `CRUSTCAPER_DB_PASSWORD` in the launching shell. Use a URL of the form `jdbc:postgresql://127.0.0.1:55438/crustcaper_dev` with your database port and name. Run the same `npm run start:local-stack` command, or `Start_Local_Stack.cmd` in the Windows archive. The launcher starts only the API and customer app in this mode. PostgreSQL continues running when the launcher exits.

```sh
npm ci
npm run build:connected-web
npm run start:local-stack
```

The customer app opens on port 47867 and the operator console on port 18080 under `/operator/index.html`. The test command `npm run test:connected` uses Chrome, creates a real local order, settles synthetic payment, checks kitchen and pickup authorization, and recovers the order from a fresh browser session. The local launcher enables the synthetic phone challenge. [Local recovery fixture](docs/ORDER_RECOVERY.md#локальная-проверка)

## Deployment configuration

Build the Linux container with `docker build -t crustcaper-api ./server` or deploy the JAR on Java 21. Use a private PostgreSQL instance and apply Flyway on the release candidate before switching traffic. Set the environment variables for the target deployment.

The Gradle suite exercises both a fresh schema and an upgrade from populated V22. To run the upgrade alone from `server/`, use `./gradlew test --tests 'com.crustcaper.api.PopulatedDatabaseMigrationTest'` against the disposable loopback test database. The test creates a temporary schema, applies V22, seeds synthetic payments and a fiscal receipt, then starts the candidate on the same schema. It checks the migration history, existing data, and recovery of the original mobile order and payment attempt. Repeat the upgrade on a protected staging copy before migrating a pilot database. Verify rollback separately with the previous candidate and the migrated staging schema.

| Variable | Value |
| --- | --- |
| `SPRING_PROFILES_ACTIVE` | Explicitly select `stage` for Flutterwave Test or `production` (alias `prod`) for Flutterwave Live. |
| `CRUSTCAPER_DB_URL`, `CRUSTCAPER_DB_USER`, `CRUSTCAPER_DB_PASSWORD` | Dedicated encrypted connection and application credentials from the deployment secret store. |
| `CRUSTCAPER_OPERATOR_MFA_KEY` | Required staff authenticator encryption key. Base64-encode 32 random bytes, use a separate key for each environment, and store it with the deployment secrets. See [Staff access](docs/OPERATIONS.md#выдача-доступа). |
| `CRUSTCAPER_PAYMENT_PROVIDER` | `flutterwave`. |
| `CRUSTCAPER_FLUTTERWAVE_PAYMENT_OPTIONS` | Approved Flutterwave checkout methods for this environment. Use `card`, `mobilemoneyrwanda`, or both separated by a comma. |
| `FLUTTERWAVE_SECRET_KEY`, `FLUTTERWAVE_WEBHOOK_SECRET`, `CRUST_PAYMENT_RETURN_URL` | Environment-specific provider configuration. See [Payments](docs/PAYMENTS.md). |
| `CRUSTCAPER_WEB_ORIGIN` | Optional exact HTTPS origin for browser checkout. Empty disables browser commerce. The storefront Compose overlay sets this from the HTTPS hostname. |
| `CRUSTCAPER_PORT` | Listener port behind the HTTPS ingress. Defaults to 8080. |

Requests wait up to five seconds for a PostgreSQL connection from the runtime pool. Runtime pgJDBC connections default to a three-second socket connect timeout and a six-second socket read timeout. Parameters with the same names in the JDBC URL take precedence. Flyway opens a separate connection at startup using the same JDBC URL and credentials by default, so migrations can run beyond the runtime read timeout. [pgJDBC connection parameters](https://jdbc.postgresql.org/documentation/use/)

For `stage`, `prod` and `production`, the API checks both JDBC URLs before connecting. Each URL must specify `sslmode=verify-full` and an absolute `sslrootcert` path to a certificate file readable by the API. Put the runtime URL in `CRUSTCAPER_DB_URL` and use the standard PostgreSQL driver and TLS transport. If you set a separate `spring.flyway.url`, apply the same requirements there. [pgJDBC TLS configuration](https://jdbc.postgresql.org/documentation/ssl/)

Production uses the real catalog loaded for the restaurant and individual operator accounts provisioned with authenticators for its store. See [Catalog](docs/CATALOG.md) and [Operations](docs/OPERATIONS.md). Configure public HTTPS routing, request limits, provider webhooks, backups and monitoring before admitting traffic. The Compose deployment keeps the readiness probe and API error counters inside its private network. [API error monitoring](docs/OPERATIONS.md#рост-ошибок-api)

The operator queue shows confirmed orders by store and role. The release procedure accounts for late or duplicate payment exceptions and fiscal receipt integration. [Release checks](../docs/runbooks/MOBILE_RELEASE.md)

Optional pickup notifications use Expo. Set the provider and server credentials only for the environments where notifications are enabled. [Pickup notification configuration](docs/PICKUP_ALERTS.md)

### Single-host HTTPS staging

The [HTTPS overlay](deploy/compose.https.yml) runs Caddy and the API on a Linux Docker host. It publishes only TCP ports 80 and 443. Caddy redirects HTTP to HTTPS, renews the certificate for the staging hostname, and stores TLS state in the `edge_data` volume. Keep that volume across container updates. When the host already has HTTPS ingress, use the [base Compose file](deploy/compose.yml) alone and route traffic to its loopback API port (`CRUSTCAPER_HTTP_PORT`, default 8080). `docker compose up -d --wait --wait-timeout 90` waits for API readiness in both modes, including PostgreSQL. Both modes use Docker Compose 2.30 or newer and take the same API environment file and PostgreSQL CA settings below. [Docker Compose env files and bind mounts](https://docs.docker.com/reference/compose-file/container-spec/)

Set an A record for the staging hostname and allow TCP 80 and 443 through the host firewall. If the hostname also has an AAAA record, verify that IPv6 reaches the ingress as well before certificate issuance. Supply a dedicated private PostgreSQL database, its PEM CA certificate, Flutterwave Test credentials and the signed staging application identities. Use the same hostname for the native client's API and return origin. [Caddy HTTPS requirements](https://caddyserver.com/docs/automatic-https)

Create `/etc/crustcaper/stage/compose.env` with the following deployment values. Set a verified image digest or a locally loaded, SHA-specific API image tag.

| Variable | Staging value |
| --- | --- |
| `CRUSTCAPER_API_IMAGE` | Verified API image for the selected release SHA. |
| `CRUSTCAPER_HTTPS_HOST` | Exact staging hostname, without a scheme or port. |
| `CRUSTCAPER_HTTPS_BIND_IP` | Host listener IP. Use `127.0.0.1` with hostname `localhost` for a private local HTTPS rehearsal. |
| `CRUSTCAPER_API_ENV_FILE` | Absolute path to the API environment file. |
| `CRUSTCAPER_POSTGRES_CA_FILE` | Absolute path to the CA PEM file, readable by the API container's UID `10001`. |

Store the API variables from the Deployment configuration section in a separate host file with mode `0600`. Use raw `KEY=value` lines without shell quoting. Set `SPRING_PROFILES_ACTIVE=stage`, `CRUSTCAPER_PAYMENT_PROVIDER=flutterwave`, the approved `CRUSTCAPER_FLUTTERWAVE_PAYMENT_OPTIONS`, and `CRUST_PAYMENT_RETURN_URL=https://<staging-host>/payment-return`. Set the JDBC URL to `jdbc:postgresql://<db-host>:5432/<db>?sslmode=verify-full&sslrootcert=/run/crustcaper/postgres-ca.crt`. The database hostname must match its certificate. Keep API secrets out of Compose interpolation values and use `config --quiet` for validation. [pgJDBC TLS configuration](https://jdbc.postgresql.org/documentation/ssl/)

Configure `CRUSTCAPER_APP_LINK_IOS_APP_ID` with the signed Apple application identifier and `CRUSTCAPER_APP_LINK_ANDROID_PACKAGE` with the signed Android package. Supply the comma-separated, colon-delimited SHA-256 signing certificate fingerprints in `CRUSTCAPER_APP_LINK_ANDROID_FINGERPRINTS`. An unconfigured platform's association URL returns 404. [Connected release checks](../docs/runbooks/CONNECTED_RELEASE.md)

From the candidate checkout on the staging host, run the same project name and files for validation, start and subsequent updates.

```sh
stage_compose() {
  docker compose --env-file /etc/crustcaper/stage/compose.env \
    --project-name crustcaper-stage \
    -f server/deploy/compose.yml -f server/deploy/compose.https.yml "$@"
}
stage_compose config --quiet
stage_compose run --rm --no-deps edge caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
stage_compose up -d --wait --wait-timeout 90
stage_compose exec -T edge wget -qO- http://api:8080/actuator/health/readiness
```

Run the [connected release checks](../docs/runbooks/CONNECTED_RELEASE.md) against the deployed HTTPS hostname. The proxy exposes customer API and Flutterwave webhook, `/operator/index.html`, `/payment-return` and the two signing association URLs. Internal health probes stay inside the Docker network. The receipt upload route accepts up to 1 MiB and other requests are capped at 64 KiB. Before allowing pilot traffic, configure log and availability monitoring, an approved request-rate policy and rehearse [database backup and recovery](docs/DATABASE_RECOVERY.md). Prepare a verified previous image reference. Roll back the container by restoring that reference and rerunning `up` only after confirming the previous image supports the current Flyway schema.

### Browser storefront

Build the storefront from the repository root with Node 24 using the same HTTPS origin configured on the API. Replace the example hostname and store ID with the approved values for the environment. The command uses one public origin for both the API and the return route and excludes the builder's local Expo environment settings.

```sh
npm ci
npm run build:storefront -- --origin https://stage.example.test --profile stage \
  --store-id kigali --psp-hosts checkout.flutterwave.com
```

For a production web export, use `--profile production` and provide the registered app identifiers with `--android-package` and `--ios-bundle-id`. Keep staging and production exports in separate directories using `--output-dir dist-storefront-<label>`. Set `CRUSTCAPER_STOREFRONT_DIR` in the Compose environment file to the absolute path of the exported `dist-storefront` directory or the selected output. Mount only the build output. Add `-f server/deploy/compose.storefront.yml` to the existing HTTPS Compose command and keep the same project name. Run the validation and health checks above using all three files. For a different ingress, serve the storefront export and API on a single origin and set `CRUSTCAPER_WEB_ORIGIN` directly in the API environment. Serve `/web-payment-return` as a storefront route with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. Keep the native association and `/payment-return` routes on the API. [Caddy static file routing](https://caddyserver.com/docs/caddyfile/directives/file_server)

Browser guest credentials are set through a first-party HttpOnly cookie. Checkout and recovery use the browser session, the server-confirmed order and the payment provider's verified result. Test the hosted flow in the same tab over HTTPS, including a failed payment and recovery after reopening the browser, with Flutterwave Test before admitting recipients to the storefront.

When the browser still has an unfinished checkout but lost the cookie and order response, recovery uses the original quote and creation key. Customers verify their checkout phone through the configured SMS provider. A verified customer can complete payment for the same order. If checkout never committed, the API releases the saved attempt only after the quote can no longer be used. Include both cases and a lost verification response in the pilot recovery test.

### Public menu

The Next.js catalog renders public menu and product HTML before JavaScript runs. It reads the same Spring Boot catalog used by checkout. The `/en` and `/rw` entry points lead to language-specific menus. `/menu/<sku>` leads to the English product page. The checkout client uses `/product/<sku>`, `/cart` and `/orders` on the same origin.

Build the catalog image from the same candidate checkout as the API and checkout client.

```sh
docker build -f storefront/Dockerfile -t crustcaper-catalog:stage .
```

Set `CRUSTCAPER_CATALOG_IMAGE` to the verified catalog image and `CRUSTCAPER_STORE_ID` to the public store ID in the Compose environment file. Add `-f server/deploy/compose.catalog.yml` after the HTTPS and storefront overlays. Run the same Compose validation and startup commands with all four files. Caddy forwards public content to the catalog on a private network and drops cookies and authorization headers from those requests. The catalog needs no API credential and exposes no host port.

The default `CRUSTCAPER_STOREFRONT_PROFILE=stage` prevents indexing. Enable `production` only when the domain, published store data, imagery and customer-facing content have been approved. Verify localized deep links, robots and sitemap on the target hostname. If the API cannot confirm the menu, the catalog returns an unavailable page and preserves the checkout client's separate order routes. [Next.js self-hosting](https://nextjs.org/docs/pages/guides/self-hosting)

The internal catalog health check returns 503 when the storefront profile, public origin, API origin or store ID is invalid. Temporary API outages surface on menu requests while the catalog process stays available for recovery. After importing the catalog and opening the store, run `node server/tooling/check-live-catalog.mjs https://stage.example.com/api/v1 kigali catalog-001 --checkout` against the public origin. Use the approved store and version. The check covers the orderable public API, both rendered locales, advertised photos, the checkout build and the guest session requirement at the storefront's origin. Mount approved photo files separately from the checkout export through the [catalog photo overlay](docs/CATALOG.md#публикация-фотографий). Use `npm run monitor:storefront -- https://stage.example.com/api/v1 kigali --watch` from outside the deployment host for ongoing incident and recovery events. [Connected release procedure](../docs/runbooks/CONNECTED_RELEASE.md) · [Availability monitoring](docs/OPERATIONS.md#проверка-доступности-снаружи)

The public `/contact` page uses the approved store information from the catalog. To publish `/privacy` and `/terms`, set `CRUSTCAPER_LEGAL_PUBLICATION_FILE` to the absolute path of the approved bilingual publication JSON, readable by catalog UID `1000`. Add `-f server/deploy/compose.legal.yml` after the catalog overlay. Production catalog readiness requires a valid publication. Recreate the catalog and edge when publishing a new edition. The order data request form remains available at `/order-privacy`. [Publication format and acceptance steps](../docs/runbooks/CONNECTED_RELEASE.md#публикация-политики-и-условий)

### Transfer verified Linux images

Use a Docker daemon that supports API 1.49 or later and has the verified `linux/amd64` image variants in its local store. On the builder, export the API, catalog and pinned Caddy image alongside a lock file. Save a SHA-256 of the lock file with the release record.

```sh
node server/tooling/package-deployment.mjs export /secure/crustcaper-images \
  "$(git rev-parse HEAD)" crustcaper-api:stage crustcaper-catalog:stage
```

On the target, use Node 24 and `tar`. Transfer the image directory and the matching source archive. Verify the lock file against the release record before importing. The loader checks the image archive against the lock and emits local immutable image references for Compose.

```sh
node server/tooling/package-deployment.mjs load /secure/crustcaper-images > /etc/crustcaper/stage/images.env

portable_compose() (
  unset CRUSTCAPER_API_IMAGE CRUSTCAPER_CATALOG_IMAGE CRUSTCAPER_EDGE_IMAGE
  docker compose --env-file /etc/crustcaper/stage/compose.env \
    --env-file /etc/crustcaper/stage/images.env --project-name crustcaper-stage \
    -f server/deploy/compose.yml -f server/deploy/compose.https.yml \
    -f server/deploy/compose.storefront.yml -f server/deploy/compose.catalog.yml \
    -f server/deploy/compose.portable.yml "$@"
)
portable_compose config --quiet
portable_compose up -d --wait --wait-timeout 90
```

Give the Compose file the host-specific storefront export, external PostgreSQL CA and API secret file described above. Add the legal publication overlay before the portable overlay for production. Use the catalog photo overlay before the portable overlay when photos are published. Keep the previous verified image archive and the previous Compose configuration as the inputs for an approved rollback. [Docker image archives](https://docs.docker.com/reference/cli/docker/image/save/)
