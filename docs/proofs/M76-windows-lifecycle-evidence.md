# M76 — Evidência do ciclo de vida Windows

Estado: **BETA de instalação Windows/WSL2**. Base: M71
`646c47b53ad7c76c0ca3010e6abdd7001aec0ae0`. Implementação isolada em
`codex/m76-windows-lifecycle-evidence`; não autoriza merge na principal,
push, PR, deploy, ativação do Docker ou exclusão de worktrees.

## Capacidade implementada

- captura somente leitura dos repositórios de certificados do Windows e dos
  diretórios de certificados do WSL2;
- comparação canônica antes/depois, com saída estruturada e código de saída
  diferente de zero quando há adição, remoção ou alteração;
- recusa de sobrescrita das evidências e validação de distribuição, esquema,
  hash, tamanho e protocolo entre PowerShell e WSL2;
- desinstalação comum remove os ponteiros operacionais `current` e
  `state/installed-commit`, preservando releases, estado e volumes;
- reinstalação da mesma release preservada volta a funcionar sem perder o
  sentinela de dados do volume;
- `-PurgeData` continua sendo o único caminho para apagar releases, estado e
  volumes, protegido pela confirmação literal já existente.

## Defeito encontrado e corrigido

Antes de `0987206`, a desinstalação preservava `state/installed-commit` e
removia `current`. O instalador recusa exatamente esse estado, portanto a
promessa “desinstalar preservando os dados e reinstalar depois” era impossível.

A correção valida, antes de qualquer remoção, que `installed-commit` é arquivo
regular sem symlink com quarenta caracteres hexadecimais e que `current`
resolve para a mesma release. Depois da remoção comprovada dos recursos
operacionais, os dois ponteiros são removidos. Releases, estado persistente,
segredos e volumes permanecem intactos na desinstalação comum.

## Provas executadas

Suíte cumulativa no Windows, com PowerShell real, Bash no WSL2 e simulador
Docker isolado:

```text
node --test tests/m6/windows-*.test.mjs
tests=17 pass=17 fail=0 duration=209075.5428ms
M6.4-A Windows preflight: PASS (19 cenários herméticos e adversariais)
M6 Windows shell: PASS (PowerShell e Bash reais, Docker isolado)
reinstall=preserved-data
```

O simulador cobre ainda:

- `installed-commit` malicioso como symlink: recusado antes de remover recursos;
- divergência entre `current` e `installed-commit`: recusada antes de remover
  recursos;
- desinstalação comum: volumes e release preservados, ponteiros operacionais
  ausentes;
- reinstalação: mesma release reativada e sentinela do volume preservado.

Portabilidade:

```text
PORTABILITY_SELF_TEST=PASS negative_fixture_rejected=true
PORTABILITY=PASS source=git findings=0
```

Trust stores reais, em duas capturas consecutivas:

```text
Windows certificates=149
WSL entries=364
added=0 removed=0 changed=0
```

Evidência retida em
`outputs/M76_WINDOWS_TRUSTSTORE_5ba7f7d/`:

- `before.json`: SHA-256
  `BDD26F4608AA006A1988AF5862FB2E83ED8FB7408569897F5A8A61316D3B6BAC`;
- `after.json`: SHA-256
  `F43FA1D44C90E706493F0D38954101B2DA404BEFCC99ACAC14DA4BD1FD33C1C9`;
- `comparison.json`: SHA-256
  `57913CE66859602B9E622E2C9C6EB02D58543E3A7C359564249645657B102B21`.

## Auditoria de segurança

- `646c47b..5ba7f7d`: scan
  `666d3b26-b7b6-40c7-addb-696dd401d888`, cobertura completa, zero achados;
- `5ba7f7d..0987206`: scan
  `304e0306-c5b5-4ec3-8b20-3c8cb63f74cc`, cobertura completa da única
  superfície de produção alterada, zero achados;
- TAC consultivo: indisponível porque o conector não estava autenticado;
- revisão delegada: indisponível; a revisão limitada ao diff foi feita
  sequencialmente pelo agente principal.

Relatório final do segundo scan:
`C:/Users/zodyp/.codex/security-scans/m76-windows-lifecycle-evidence/098720641e37ac15e122fd58aecab03855c7c9b0_20260906T195855Z_2xeb5d0m/report.md`.

## Limites honestos

- o Docker Desktop permaneceu desligado; o ciclo real com imagens do produto é
  `NOT_EXECUTED`;
- a prova usa o simulador Docker já auditado para validar escopo, ordem das
  operações, falhas e persistência do sentinela;
- capturas iguais provam que os trust stores não mudaram entre os dois momentos;
  não são evidência assinada nem monitoramento contínuo;
- nenhum merge, push, PR, deploy, limpeza ou exclusão foi realizado.

O resultado fecha a evidência local da correção e mantém o produto em BETA até
o ciclo real do Docker Desktop e os gates externos da fase 9.
