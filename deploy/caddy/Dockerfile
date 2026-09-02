FROM caddy:2.11.4-builder-alpine@sha256:fc72c8a37cb774f155094d7f08e48b67876477e0d11ca96f58d9cf5b0cff42c8 AS builder
RUN xcaddy build \
  --with github.com/mholt/caddy-ratelimit@5625512f24f6f59d6f64fb3aafe5eecff0b286db

FROM caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
# xcaddy adds a file capability in the builder. Containers receive only the
# capability declared by Compose; the executable itself carries none.
RUN setcap -r /usr/bin/caddy
COPY deploy/caddy/DZ23.common.caddy /etc/caddy/DZ23.common.caddy
COPY deploy/caddy/Caddyfile* /etc/caddy/
COPY deploy/caddy/public/login /srv/login
COPY apps/studio-web/public/brand/dz23-studio-logo.jpg /srv/login-assets/dz23-studio-logo.jpg
COPY deploy/caddy/public/assets/login /srv/login-assets
