# runonflux/ghost-flux: Ghost for the Flux network, as the first component of a three-component
# app (ghost + mysql + runonflux/shared-db operator), the shape WordPress already runs on Flux.
#
# The official image is used as it is; this adds a supervisor (PID 1 under tini) and nginx in front
# of Ghost. See README.md for why each piece exists.
ARG BASE_IMAGE=ghost:6.78.0-alpine
FROM ${BASE_IMAGE}

ARG FLUX_IMAGE_VERSION=dev
ARG BASE_DIGEST=unknown
ARG REVISION=unknown

# mariadb-client: the dump/import tools, the same client runonflux/wp-nginx's wp-cli uses.
# mariadb-connector-c: its caching_sha2_password plugin, for a plain MySQL 8 (the shared-db
# operator itself switches every client to mysql_native_password).
RUN apk add --no-cache nginx tini curl mariadb-client mariadb-connector-c \
 && rm -f /etc/nginx/http.d/default.conf \
 && mkdir -p /run/nginx /flux

COPY flux/ /flux/
RUN node --check /flux/supervisor.js \
 && node --check /flux/lib.js \
 && node --check /flux/db.js \
 && node --check /flux/cli.js \
 && printf '#!/bin/sh\nexec node /flux/cli.js "$@"\n' > /usr/local/bin/flux-ghost \
 && chmod +x /usr/local/bin/flux-ghost

ENV FLUX_IMAGE_VERSION=${FLUX_IMAGE_VERSION} \
    FLUX_PUBLIC_PORT=2368 \
    FLUX_GHOST_PORT=2369 \
    NODE_ENV=production

LABEL org.opencontainers.image.title="ghost-flux" \
      org.opencontainers.image.description="Ghost on Flux: three-component app with the shared-db operator" \
      org.opencontainers.image.source="https://github.com/RunOnFlux/ghost-flux" \
      org.opencontainers.image.version="${FLUX_IMAGE_VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.base.name="${BASE_IMAGE}" \
      org.opencontainers.image.base.digest="${BASE_DIGEST}"

EXPOSE 2368
VOLUME /var/lib/ghost/content
HEALTHCHECK --interval=30s --timeout=5s --start-period=10m --retries=3 \
  CMD curl -fsS -o /dev/null http://127.0.0.1:2368/flux/health || exit 1

ENTRYPOINT ["/sbin/tini", "-g", "--"]
CMD ["node", "/flux/supervisor.js"]
