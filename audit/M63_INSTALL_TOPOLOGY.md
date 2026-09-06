# M6.3b — Topologia de instalação e typecheck agregado

- data: `2026-09-06T04:53:52-03:00`
- branch candidata: `codex/m63-install-topology`
- base: `bb4bf55bad031a3f27916d957f2a89755ed32182`
- principal preservada: `codex/p30-policy-foundation@17e79aaab4c1ac54c1b4fc05f780f6485c5941b7`
- classificação: `REVIEW_REQUIRED`

## Problema

O `pnpm typecheck` agregado encontrava identidades nominais diferentes para os mesmos tipos do Studio. A configuração global `injectWorkspacePackages: true` criava cópias físicas de todos os pacotes do workspace. Essas cópias não continham os fontes declarados em `types: ./src/index.ts`, porque os manifestos publicáveis incluem somente `lib/`, e o TypeScript acabava combinando árvores físicas distintas.

## Causa raiz e correção

A injeção global foi removida. O workspace de desenvolvimento volta a usar links para uma única identidade de cada pacote. Somente os três insumos do artefato final são injetados explicitamente em `apps/studio-runtime/package.json`:

1. `@deepseek-ai/dsh`;
2. `@dz23-studio/storage-postgres`;
3. `dsh-profile-studio`.

O deploy do runtime usa `pnpm deploy --legacy --prod --offline`, pois o modo atual de deploy exige injeção global por padrão. O Dockerfile mantém a segunda instalação limpa após o build para renovar exclusivamente os snapshots seletivamente injetados.

Os aliases de teste para `@dz23-studio/preview-supervisor` e `@dz23-studio/runtime-governor` também foram explicitados, eliminando resolução acidental por artefatos `lib/` antigos.

## Provas executadas

Ambiente: WSL2/Ubuntu em ext4, checkout isolado `/home/leandro/dz23-gates/m63-integration-20260906`, instalação offline com lock fixado.

| Gate | Resultado |
| --- | --- |
| `pnpm install --offline --frozen-lockfile` | `PASS` |
| `tsc --noEmit` agregado com o `tsconfig.json` canônico | `PASS` |
| build da interface e dos 14 plugins | `PASS` |
| suíte integral em um worker | `1.896 passed`, `61 skipped`, `0 failed` |
| gate de imagem/topologia | `5/5 passed` |
| `check-image-lock.mjs` | `PASS` |
| deploy de runtime após o build | `PASS`, 533 pacotes reutilizados, 0 downloads |
| executável, operador e contrato de shutdown | presentes |
| Harness, armazenamento Postgres e perfil | presentes |
| interface compilada e template Prompt-to-App | presentes |
| portabilidade Git e filesystem + self-test negativo | `PASS` |
| i18n | `PASS`, 9 catálogos e 287 chaves |
| escopos e rotas de domínio | `PASS`, 23 domínios em 2 patches |
| `git diff --check` | `PASS` |
| varredura do diff por chaves privadas e tokens conhecidos | nenhum achado |

Os 61 testes pulados continuam sendo integrações que exigem PostgreSQL externo e não foram contados como aprovação. Docker permaneceu desligado; a prova acima valida o diretório produzido por `pnpm deploy`, não uma imagem OCI.

## Regressões impedidas

- o gate falha se a injeção global voltar a ser ativada;
- o gate falha se outro pacote for adicionado à lista seletiva sem atualização deliberada;
- o gate falha se o Dockerfile remover `--legacy`, `--prod` ou `--offline`;
- o typecheck usa os fontes canônicos, sem `paths` corretivos, casts ou relaxamento de tipos;
- o deploy final prova os arquivos efetivamente exigidos pela imagem.

## Pendências preservadas

- 95 arquivos `plugins/*/lib/**` antigos ainda são rastreados pelo Git. Removê-los do índice é uma limpeza ampla e deve ocorrer em commit separado, com reconstrução e revisão próprias.
- a imagem Docker real, isolamento de rede, inspeção de capabilities e smoke contêiner-a-contêiner continuam `NOT_EXECUTED`;
- as 61 integrações PostgreSQL, gate Windows, cinco sessões leigas, piloto, licença e release continuam pendentes;
- o gate completo de origem ainda não pode validar `origin`, pois este repositório local não possui remoto.

## Decisão

A causa do typecheck agregado está fechada estruturalmente e o workaround alternativo `2c6dd4031afe0e2e9499772145810a0114473b98` não deve ser integrado. Esta ponta continua sem merge até revisão independente.
