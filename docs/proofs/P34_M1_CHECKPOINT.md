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
- revisão adversarial independente do núcleo: `GO`, zero ALTA/MÉDIA.

A cobertura global mais recente antes do checkpoint passou com 377 testes e
18 pulados: 94,65% statements, 90,92% branches, 94,94% functions e 97,34%
lines; o gate crítico de importação ficou em 100% nas quatro métricas.

## Provas que não aconteceram

- supervisor Docker real e cópia atômica do artefato: `NOT_CONFIGURED`;
- rede interna por preview e tentativas reais de egress: `NOT_EXECUTED`;
- Caddy roteando `p-<id>.localhost`: `NOT_EXECUTED`;
- cookie/admissão no navegador real e revogação no request seguinte:
  `NOT_EXECUTED`;
- HTTPS/ACME, celular e domínio público: `NOT_EXECUTED`;
- Playwright visual desta rodada: `BLOCKED_EXTERNAL` pelas bibliotecas nativas
  ausentes no WSL. O teste HTTP de recusa sem sessão passou antes da tentativa
  de abrir o navegador.

Docker Desktop estava desligado/indisponível. Nenhum privilégio, CA, trust
store, arquivo de hosts, MITM, TPROXY, push, PR ou deploy foi usado.

## Veredito honesto

O núcleo e a interface da prévia são `BETA`; a capacidade utilizável permanece
`NOT_CONFIGURED`. Não há base para `PREVIEW_OK`, publicação ou aplicação pronta.
M1 só fecha quando supervisor, Caddy, isolamento físico e jornada de navegador
passarem no artefato exato.
