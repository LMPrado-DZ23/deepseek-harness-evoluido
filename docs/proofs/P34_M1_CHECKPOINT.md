# P34/M1 — checkpoint verificável da prévia segura

Data: 03/09/2026. Branch: `codex/missao-m1-preview`. Base imutável:
`ec92f29f7398d1ac69dc6201e5fb8e6bccfa60b9`.

## Construído

- `302b582`: gate AST da fonte gerada antes de escrita/execução.
- `c861fc3`: vínculo do run `PASSED` ao SHA-256 integral, domínios tenant-aware,
  lifecycle, TTL, locks, reconciliação, timeout de runtime, admissão opaca,
  gateway e modo de e-mail `studio-preview`.
- `76ebca0`: tipagem exata do teste de inventário de runtime bloqueado.
- `068a212`: jornada visual com iframe de origem separada, sandbox,
  `referrerPolicy=no-referrer`, troca do ticket via `postMessage`, aviso de
  prévia não publicada, códigos locais e ação de encerramento.
- `09348fb`: prova Playwright determinística composta com serviço, extensão
  HTTP e gateway reais; apenas supervisor e encaminhamento são doubles.
- `a251fc5`: singleton físico fail-closed, readiness, heartbeat limitado a
  duas horas e mutex único de admissões. A revisão adversarial encontrou e a
  correção fechou uma corrida que poderia restaurar ticket consumido; cleanup
  incompleto permanece `STOPPING` e impede novo runtime.

O Harness upstream permaneceu no pin
`6c705be1ce6774a000d061da41d1823b03a3d42c` sem alteração.

## Provas executadas

Ambiente canônico desta rodada: cópia limpa em ext4 no WSL2, pnpm 11.7.0.

- instalação com lockfile fixado: `PASS`;
- typecheck: `PASS`;
- testes focados de preview e vínculo de artefato: 64/64 `PASS`;
- gate i18n: `PASS`, 208 chaves pt-BR;
- gate de escopo tenant: `PASS`;
- build dos 11 pacotes: `PASS`;
- P37 self-test positivo/negativo e scan da árvore: `PASS`, incluindo recusa
  de artefato vazio, MITM, `freestyle`, `caveman-shrink` e licença ausente;
- revisão adversarial independente do núcleo: `GO`, zero ALTA/MÉDIA.

A cobertura global no snapshot endurecido passou com 387 testes e 18 pulados:
94,83% statements, 90,97% branches, 95,64% functions e 97,36% lines; o gate
crítico de importação ficou em 100% nas quatro métricas. A suíte focada final
do preview passou 65/65.

## Provas que não aconteceram

- supervisor Docker real e cópia atômica do artefato: `NOT_CONFIGURED`;
- rede interna por preview e tentativas reais de egress: `NOT_EXECUTED`;
- Caddy roteando `p-<id>.localhost`: `NOT_EXECUTED`;
- cookie/admissão no navegador real e revogação no request seguinte:
  `NOT_EXECUTED`;
- HTTPS/ACME, celular e domínio público: `NOT_EXECUTED`;
- Playwright visual desta rodada: teste escrito e compilado, mas execução do
  navegador `BLOCKED_EXTERNAL` pelas bibliotecas nativas ausentes no WSL e
  pelo executável Chromium ausente no host Windows. O teste HTTP de recusa sem
  sessão passou antes da tentativa de abrir o navegador.

Docker Desktop estava desligado/indisponível. Nenhum privilégio, CA, trust
store, arquivo de hosts, MITM, TPROXY, push, PR ou deploy foi usado.

## Veredito honesto

O núcleo e a interface da prévia são `BETA`; a capacidade utilizável permanece
`NOT_CONFIGURED`. A revisão final do núcleo foi `GO`, sem ALTA/MÉDIA. Não há
base para `PREVIEW_OK`, publicação ou aplicação pronta. M1 só fecha quando
supervisor, Caddy, isolamento físico e jornada de navegador passarem no
artefato exato.
