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

For an existing PostgreSQL 17 installation, create a dedicated empty local test database. Point `CRUSTCAPER_DB_URL`, `CRUSTCAPER_DB_USER` and `CRUSTCAPER_DB_PASSWORD` at that database for Gradle tests and the local JAR. Start the JAR with `--spring.profiles.active=local` and `CRUSTCAPER_PORT=18080`, then use `node tooling/preview-server.cjs dist-connected` from the repository root. Set `CRUSTCAPER_ORDER_ACCESS_PROVIDER=local` for synthetic phone verification.

```sh
npm ci
npm run build:connected-web
npm run start:local-stack
```

The customer app opens on port 47867 and the operator console on port 18080 under `/operator/index.html`. The test command `npm run test:connected` uses Chrome, creates a real local order, settles synthetic payment, checks kitchen and pickup authorization, and recovers the order from a fresh browser session. The local launcher enables the synthetic phone challenge. [Local recovery fixture](docs/ORDER_RECOVERY.md#локальная-проверка)

## Deployment configuration

Build the Linux container with `docker build -t crustcaper-api ./server` or deploy the JAR on Java 21. Use a private PostgreSQL instance and apply Flyway on the release candidate before switching traffic. Set the environment variables for the target deployment.

| Variable | Value |
| --- | --- |
| `SPRING_PROFILES_ACTIVE` | `stage` for Flutterwave Test or `production` for Flutterwave Live. |
| `CRUSTCAPER_DB_URL`, `CRUSTCAPER_DB_USER`, `CRUSTCAPER_DB_PASSWORD` | Dedicated encrypted connection and application credentials from the deployment secret store. |
| `CRUSTCAPER_PAYMENT_PROVIDER` | `flutterwave`. |
| `FLUTTERWAVE_SECRET_KEY`, `FLUTTERWAVE_WEBHOOK_SECRET`, `CRUST_PAYMENT_RETURN_URL` | Environment-specific provider configuration. See [Payments](docs/PAYMENTS.md). |
| `CRUSTCAPER_PORT` | Listener port behind the HTTPS ingress. Defaults to 8080. |

Production uses the real catalog loaded for the restaurant and individual operator accounts provisioned for its store. See [Catalog](docs/CATALOG.md) and [Operations](docs/OPERATIONS.md). Configure public HTTPS routing, request limits, provider webhooks, backups and monitoring before admitting traffic. A readiness probe is available at `/actuator/health/readiness`; details and other management endpoints are withheld.

The operator queue shows confirmed orders by store and role. The release procedure accounts for late or duplicate payment exceptions and fiscal receipt integration. [Release checks](../docs/runbooks/MOBILE_RELEASE.md)

Optional pickup notifications use Expo. Set the provider and server credentials only for the environments where notifications are enabled. [Pickup notification configuration](docs/PICKUP_ALERTS.md)

### Single-host HTTPS staging

The [HTTPS overlay](deploy/compose.https.yml) runs Caddy and the API on a Linux Docker host with Docker Compose 2.30 or newer. It publishes only TCP ports 80 and 443. Caddy redirects HTTP to HTTPS, renews the certificate for the staging hostname, and stores TLS state in the `edge_data` volume. Keep that volume across container updates. The [base Compose file](deploy/compose.yml) can also run alone with a loopback API port when the host already has HTTPS ingress.

Set an A record for the staging hostname and allow TCP 80 and 443 through the host firewall. If the hostname also has an AAAA record, verify that IPv6 reaches the ingress as well before certificate issuance. Supply a dedicated private PostgreSQL database, its PEM CA certificate, Flutterwave Test credentials and the signed staging application identities. Use the same hostname for the native client's API and return origin. [Caddy HTTPS requirements](https://caddyserver.com/docs/automatic-https)

Create `/etc/crustcaper/stage/compose.env` with the following deployment values. Set a verified image digest or a locally loaded, SHA-specific API image tag.

| Variable | Staging value |
| --- | --- |
| `CRUSTCAPER_API_IMAGE` | Verified API image for the selected release SHA. |
| `CRUSTCAPER_HTTPS_HOST` | Exact staging hostname, without a scheme or port. |
| `CRUSTCAPER_HTTPS_BIND_IP` | Host listener IP. Use `127.0.0.1` with hostname `localhost` for a private local HTTPS rehearsal. |
| `CRUSTCAPER_API_ENV_FILE` | Absolute path to the API environment file. |
| `CRUSTCAPER_POSTGRES_CA_FILE` | Absolute path to the CA PEM file, readable by the API container's UID `10001`. |

Store the API variables from the Deployment configuration section in a separate host file with mode `0600`. Use raw `KEY=value` lines without shell quoting. Set `SPRING_PROFILES_ACTIVE=stage`, `CRUSTCAPER_PAYMENT_PROVIDER=flutterwave`, and `CRUST_PAYMENT_RETURN_URL=https://<staging-host>/payment-return`. Set the JDBC URL to `jdbc:postgresql://<db-host>:5432/<db>?sslmode=verify-full&sslrootcert=/run/crustcaper/postgres-ca.crt`; the database hostname must match its certificate. Keep API secrets out of Compose interpolation values and use `config --quiet` for validation. [pgJDBC TLS configuration](https://jdbc.postgresql.org/documentation/ssl/)

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
