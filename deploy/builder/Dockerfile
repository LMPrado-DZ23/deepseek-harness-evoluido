FROM mcr.microsoft.com/playwright@sha256:ac7053180325ef75d31774c458d0bb9b55ac153ae1be3d104b80c6c1bb6a067c
ARG TARGETARCH
ARG NODE_VERSION=22.23.1
RUN case "${TARGETARCH}" in \
      amd64) NODE_ARCH=x64; NODE_SHA256=7a8cb04b4a1df4eaf432125324b81b29a088e73570a23259a8de1c65d07fc129 ;; \
      arm64) NODE_ARCH=arm64; NODE_SHA256=543fa39e57d4c07855939459a323f4deb9a79dd1bb45e6e99458b0f2de10db8d ;; \
      *) echo "Arquitetura recusada: ${TARGETARCH}" >&2; exit 64 ;; \
    esac \
    && curl --fail --silent --show-error --location "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.gz" --output /tmp/node.tar.gz \
    && echo "${NODE_SHA256}  /tmp/node.tar.gz" | sha256sum --check --strict \
    && tar --extract --gzip --file /tmp/node.tar.gz --directory /usr/local --strip-components=1 \
    && rm /tmp/node.tar.gz \
    && test "$(node --version)" = "v${NODE_VERSION}" \
    && curl --fail --silent --show-error --location "https://registry.npmjs.org/pnpm/-/pnpm-11.7.0.tgz" --output /tmp/pnpm.tgz \
    && echo "deafa7ec98a1218b6a047289b92fbe2395c1e22d3495bb711653013218ee15ee  /tmp/pnpm.tgz" | sha256sum --check --strict \
    && npm install --global --ignore-scripts --no-audit --no-fund /tmp/pnpm.tgz \
    && rm /tmp/pnpm.tgz \
    && test "$(pnpm --version)" = "11.7.0" \
    && groupadd --gid 10001 studio \
    && useradd --uid 10001 --gid 10001 --create-home studio
WORKDIR /opt/template/static
COPY templates/static-site@1/package.json templates/static-site@1/pnpm-lock.yaml ./
RUN pnpm fetch --frozen-lockfile --store-dir /opt/pnpm-store
WORKDIR /opt/template/nextjs
COPY templates/nextjs-app@1/package.json templates/nextjs-app@1/pnpm-lock.yaml ./
RUN pnpm fetch --frozen-lockfile --store-dir /opt/pnpm-store && chmod -R a=rX /opt/pnpm-store
USER 10001:10001
ENV HOME=/home/studio PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENTRYPOINT []
