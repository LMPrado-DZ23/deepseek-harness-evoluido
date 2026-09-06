# M6.3b — Topologia de instalação e locks de desenvolvimento/release

- data: `2026-09-06T05:41:00-03:00`
- branch candidata: `codex/m64-integration-candidate`
- base: `bb4bf55bad031a3f27916d957f2a89755ed32182`
- principal preservada: `codex/p30-policy-foundation@17e79aaab4c1ac54c1b4fc05f780f6485c5941b7`
- classificação: `REVIEW_REQUIRED`

## Problema

O `pnpm typecheck` agregado encontrava identidades nominais diferentes para os mesmos tipos do Studio. A configuração global `injectWorkspacePackages: true` criava cópias físicas de todos os pacotes do workspace. Essas cópias não continham os fontes declarados em `types: ./src/index.ts`, porque os manifestos publicáveis incluem somente `lib/`, e o TypeScript acabava combinando árvores físicas distintas.

A primeira correção usou `pnpm deploy --legacy`. Uma repetição com store novo mostrou que esse caminho não é reprodutível: o lock raiz fixava `koffi@3.2.0`, mas o deploy legado re-resolveu a faixa e pediu o tarball de `koffi@3.2.1`. O passe anterior dependia do conteúdo incidental do cache e foi revogado.

## Causa raiz e correção final

Há agora duas topologias explícitas, produzidas pelos mesmos manifestos:

1. `pnpm-workspace.yaml` + `pnpm-lock.yaml`: desenvolvimento com `injectWorkspacePackages: false`, preservando uma identidade canônica para os tipos;
2. `pnpm-workspace.release.yaml` + `pnpm-lock.release.yaml`: release com `injectWorkspacePackages: true`, permitindo que o deploy moderno derive um lock dedicado do lock compartilhado.

O Dockerfile busca as duas árvores de dependências antes de desligar a rede. Depois de compilar o upstream fixado, troca os nomes canônicos apenas dentro da imagem, instala a topologia de release com `--offline --frozen-lockfile`, recompila os pacotes e usa `pnpm deploy` moderno, também offline e apontando explicitamente para o store montado.

O único postinstall local necessário é `@deepseek-ai/dsh-subprocess-local`. O modo moderno o representa como URL absoluta. O arquivo de workspace contém um marcador inerte, substituído pelo caminho fixo `/workspace` no build. O gate exige o lock local `file:third_party/deepseek-harness/...` e recusa qualquer resolução versionada externa com esse nome.

## Provas executadas

Ambiente: WSL2/Ubuntu em ext4, cópia isolada `/home/leandro/dz23-gates/m63-release-proof-20260906`, store novo `/home/leandro/dz23-gates/pnpm-store-m63-clean-20260906`.

| Gate | Resultado |
| --- | --- |
| lock de release gerado a partir dos mesmos manifestos | `PASS`, `injectWorkspacePackages: true` |
| fetch da topologia de release com lock congelado | `PASS`, 909 pacotes reutilizados, 0 downloads na repetição |
| instalação limpa de release | `PASS`, 2.680 ligações, 0 downloads |
| build da interface e dos 14 plugins | `PASS` |
| reinstalação pós-build para renovar snapshots | `PASS`, 0 downloads |
| deploy moderno `--prod --offline` com store explícito | `PASS`, 533 pacotes, 0 downloads |
| executável, operador e contrato de shutdown | presentes |
| Harness, armazenamento Postgres e perfil | presentes |
| interface compilada e template Prompt-to-App | presentes |
| gate de imagem/topologia | `5/5 passed` no Windows e no WSL |
| `check-image-lock.mjs` | `PASS` no Windows e no WSL |

No mesmo staging com a topologia de desenvolvimento, o typecheck agregado e o build completo passaram. A primeira repetição paralela da suíte registrou `1.895 passed`, `61 skipped` e um timeout de 5 segundos em `store-provision.spec.ts`; o teste passou isolado três vezes em 2,19–2,35 segundos. A repetição integral com um worker fechou em `1.896 passed`, `61 skipped`, `0 failed`. O evento fica classificado como intermitência de carga, não ocultado. Os 61 pulados exigem PostgreSQL externo e não são contados como aprovação.

## Regressões impedidas

- desenvolvimento falha se a injeção global voltar a ser ativada;
- release falha se a injeção estiver desligada ou se divergir do workspace de desenvolvimento além dessa chave;
- release falha se o lock não registrar a mesma topologia injetada;
- o gate rejeita `--legacy`, ausência de `--prod`, ausência de `--offline` ou store não explícito;
- o gate rejeita a ausência da troca controlada dos dois arquivos antes do fetch e da instalação;
- a permissão do postinstall é condicionada à resolução local fixada do pacote;
- o deploy final verifica os arquivos efetivamente exigidos pela imagem.

## Pendências preservadas

- Docker continua desligado: imagem OCI, isolamento de rede, capabilities e smoke contêiner-a-contêiner são `NOT_EXECUTED`;
- o navegador Chromium do WSL não iniciou por ausência de `libnss3.so`; 2 testes estáticos passaram e 10 testes de navegador são `BLOCKED_ENVIRONMENT`, não aprovação nem falha do produto;
- 95 arquivos `plugins/*/lib/**` antigos continuam rastreados; nenhuma limpeza foi autorizada;
- 61 integrações PostgreSQL, prova física Windows, cinco sessões leigas, piloto, licença e release continuam pendentes;
- o gate completo de origem não valida `origin`, pois o repositório local não possui remoto.

## Decisão

O workaround `2c6dd4031afe0e2e9499772145810a0114473b98` e o deploy legado de `8059590adb14ea6464d559836ae4cb51117f9a71` foram superados. A candidata usa a topologia dual e deploy moderno congelado; continua sem merge até revisão independente.
