FROM mcr.microsoft.com/playwright@sha256:ac7053180325ef75d31774c458d0bb9b55ac153ae1be3d104b80c6c1bb6a067c
ARG NODE_VERSION=22.23.1
ARG NODE_SHA256=7a8cb04b4a1df4eaf432125324b81b29a088e73570a23259a8de1c65d07fc129
RUN curl --fail --silent --show-error --location "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz" --output /tmp/node.tar.gz \
    && echo "${NODE_SHA256}  /tmp/node.tar.gz" | sha256sum --check --strict \
    && tar --extract --gzip --file /tmp/node.tar.gz --directory /usr/local --strip-components=1 \
    && rm /tmp/node.tar.gz \
    && test "$(node --version)" = "v${NODE_VERSION}" \
    && npm install --global pnpm@11.7.0 \
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
