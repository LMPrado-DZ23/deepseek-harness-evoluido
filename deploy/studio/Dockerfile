# syntax=docker/dockerfile:1.7
FROM docker.io/library/node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS git-runtime

RUN apt-get update \
 && apt-get install --yes --no-install-recommends git=1:2.39.5-0+deb12u3 \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 studio \
 && useradd --uid 10001 --gid 10001 --home-dir /var/lib/dz23-studio --no-create-home --shell /usr/sbin/nologin studio \
 && test "$(git --version)" = "git version 2.39.5"

FROM git-runtime AS toolchain
WORKDIR /workspace
ENV CI=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PNPM_STORE_DIR=/pnpm/store
COPY deploy/images.lock.json deploy/images.lock.json
COPY scripts/check-image-lock.mjs scripts/check-image-lock.mjs
COPY scripts/fetch-verified-pnpm.mjs scripts/fetch-verified-pnpm.mjs
RUN node scripts/check-image-lock.mjs \
 && node scripts/fetch-verified-pnpm.mjs --output /tmp/pnpm.tgz \
 && npm install --global --ignore-scripts --no-audit --no-fund /tmp/pnpm.tgz \
 && rm /tmp/pnpm.tgz \
 && test "$(pnpm --version)" = "11.7.0"

FROM toolchain AS dependency-fetch
WORKDIR /workspace
COPY . .
ENV DSH_CLIENT_COMMIT_HASH=6c705be1ce6774a000d061da41d1823b03a3d42c
RUN --mount=type=cache,id=dz23-studio-pnpm-11,target=/pnpm/store,sharing=locked \
    node scripts/check-upstream-content.mjs --materialize-symlinks \
 && node scripts/check-portability.mjs --all-files \
 && pnpm fetch --frozen-lockfile --store-dir /pnpm/store \
 && touch /workspace/.dz23-fetch-complete

FROM toolchain AS build
ARG STUDIO_COMMIT
WORKDIR /workspace
ENV DSH_CLIENT_COMMIT_HASH=6c705be1ce6774a000d061da41d1823b03a3d42c
COPY --from=dependency-fetch /workspace/.dz23-fetch-complete /tmp/.dz23-fetch-complete
COPY . .
# The pinned upstream ships its own workspace boundary. The product build uses
# the single audited root lockfile, so remove only the build-container copies
# after integrity verification. Otherwise nested pnpm invocations try to
# resolve the second lockfile and escape the offline build boundary.
RUN test -n "${STUDIO_COMMIT}" \
 && test -f /tmp/.dz23-fetch-complete \
 && node scripts/check-image-lock.mjs \
 && node scripts/check-upstream-content.mjs --materialize-symlinks \
 && node scripts/check-portability.mjs --all-files \
 && rm third_party/deepseek-harness/pnpm-workspace.yaml \
       third_party/deepseek-harness/pnpm-lock.yaml
RUN --mount=type=cache,id=dz23-studio-pnpm-11,target=/pnpm/store,sharing=locked \
    --network=none \
    pnpm install --offline --frozen-lockfile --trust-lockfile --store-dir /pnpm/store
# The upstream build script intentionally addresses these paths relative to
# its repository root. The unified workspace hoists them to /workspace, so
# expose only the two paths the pinned build contract requires.
RUN mkdir -p third_party/deepseek-harness/node_modules \
 && if [ ! -e third_party/deepseek-harness/node_modules/typescript ]; then \
      ln -s /workspace/node_modules/typescript third_party/deepseek-harness/node_modules/typescript; \
    fi \
 && if [ ! -e third_party/deepseek-harness/node_modules/@types ]; then \
      ln -s /workspace/node_modules/@types third_party/deepseek-harness/node_modules/@types; \
    fi \
 && test -f third_party/deepseek-harness/node_modules/typescript/bin/tsc
RUN --network=none pnpm --dir third_party/deepseek-harness build:official
# Reinject the upstream packages after build:official; their lib/ trees do not
# exist in the source snapshot used by the first install.
RUN --mount=type=cache,id=dz23-studio-pnpm-11,target=/pnpm/store,sharing=locked \
    --network=none \
    pnpm install --offline --frozen-lockfile --trust-lockfile --force --store-dir /pnpm/store
RUN --mount=type=cache,id=dz23-studio-pnpm-11,target=/pnpm/store,sharing=locked \
    --network=none pnpm build
# Synchronize every built workspace package into the deployable virtual store.
RUN --mount=type=cache,id=dz23-studio-pnpm-11,target=/pnpm/store,sharing=locked \
    --network=none \
    pnpm install --offline --frozen-lockfile --trust-lockfile --force --store-dir /pnpm/store \
 && pnpm --filter @dz23-studio/runtime deploy --prod /opt/runtime \
 && test -f /opt/runtime/entrypoint.mjs \
 && test -f /opt/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js \
 && test -f /opt/runtime/node_modules/@dz23-studio/web/lib/client/index.html \
 && test -f /opt/runtime/node_modules/@dz23-studio/prompt-to-app/template/nextjs-app@1/package.json

FROM git-runtime AS runtime
LABEL org.opencontainers.image.title="DZ23 STUDIO" \
      org.opencontainers.image.description="Runtime do DZ23 STUDIO sobre uma revisão fixada do DeepSeek Harness"
ARG STUDIO_COMMIT
ENV NODE_ENV=production \
    HOME=/var/lib/dz23-studio \
    DSH_HOME=/var/lib/dz23-studio \
    DSH_TELEMETRY_DISABLED=1 \
    DZ23_STUDIO_IMAGE_REVISION=${STUDIO_COMMIT}
WORKDIR /opt/dz23-studio/runtime
COPY --from=build --chown=10001:10001 /opt/runtime/ ./
COPY --from=build --chown=10001:10001 /workspace/deploy/harness/ /opt/dz23-studio/deploy/harness/
RUN mkdir -p /var/lib/dz23-studio /var/lib/dz23-studio-backups \
 && chown -R 10001:10001 /var/lib/dz23-studio /var/lib/dz23-studio-backups
USER 10001:10001
EXPOSE 3210
VOLUME ["/var/lib/dz23-studio", "/var/lib/dz23-studio-backups"]
ENTRYPOINT ["node", "entrypoint.mjs"]
