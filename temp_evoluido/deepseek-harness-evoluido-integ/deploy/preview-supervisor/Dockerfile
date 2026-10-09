ARG DZ23_SUPERVISOR_BASE_IMAGE=dz23-studio-builder:local
FROM ${DZ23_SUPERVISOR_BASE_IMAGE}

LABEL org.opencontainers.image.title="DZ23 STUDIO preview supervisor" \
      org.opencontainers.image.description="Narrow local control plane for isolated preview containers"

USER 0:0
RUN install -d -o 10001 -g 10001 -m 0770 /run/dz23-preview /run/dz23-preview-proxies
USER 10001:10001
WORKDIR /opt/dz23-preview-supervisor
COPY --chown=10001:10001 plugins/preview-supervisor/lib ./lib
# O catálogo de mensagens: `lib/i18n.js` o lê de `../i18n` ao carregar. Sem
# esta linha a imagem não subia (medido em 19/09/2026, primeira execução real).
COPY --chown=10001:10001 plugins/preview-supervisor/i18n ./i18n
ENTRYPOINT []
CMD ["node", "/opt/dz23-preview-supervisor/lib/supervisor-main.js"]
