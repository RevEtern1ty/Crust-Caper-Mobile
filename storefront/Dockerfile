FROM node:24.22.3-bookworm-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530 AS build
WORKDIR /source/storefront
ENV NEXT_TELEMETRY_DISABLED=1
COPY storefront/package.json storefront/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY assets /source/assets
COPY storefront ./
RUN npm run build

FROM node:24.22.3-bookworm-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530
WORKDIR /app/storefront
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build /source/storefront/.next/standalone /app
COPY --from=build /source/storefront/.next/static ./.next/static
USER 1000:1000
EXPOSE 3000
CMD ["node", "server.js"]
