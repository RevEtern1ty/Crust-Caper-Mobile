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

```sh
npm ci
npm run build:connected-web
npm run start:local-stack
```

The customer app opens on port 47867 and the operator console on port 18080 under `/operator/index.html`. The test command `npm run test:connected` uses Chrome, creates a real local order, settles the synthetic payment through the local API, then checks kitchen authorization and pickup. The server keeps customer and operator session data separate.

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

The [deployment Compose file](deploy/compose.yml) runs the API with a read-only root filesystem and loopback listener for a host HTTPS proxy. Set `CRUSTCAPER_API_IMAGE` to the selected image and `CRUSTCAPER_API_ENV_FILE` to the path of the separate environment file. Use a PostgreSQL connection with server certificate and hostname verification. Point the proxy at the configured loopback port and apply the traffic and webhook policies for the environment.
