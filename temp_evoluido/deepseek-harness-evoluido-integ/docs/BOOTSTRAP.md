# Bootstrap canônico do DZ23 STUDIO

Este é o procedimento de instalação e verificação de uma árvore limpa. Execute na raiz do repositório. Ele não inicia serviços, não cria contêineres e não faz deploy.

> Para **abrir o produto**, e não para provar a árvore, o caminho curto é [`COMECAR.md`](./COMECAR.md): `pnpm studio:doctor` confere estes mesmos pré-requisitos e devolve um comando por vez, e `pnpm studio` dá a partida.

## Pré-requisitos fixados

- Git com suporte a submódulos e symlinks;
- Node.js `22.23.1`;
- pnpm `11.7.0` indicado por `packageManager`;
- no Windows nativo, Modo de Desenvolvedor e `core.symlinks=true`; sem isso, use WSL2 com o clone no ext4 (`~/...`), nunca em `/mnt/c` para o gate completo;
- PostgreSQL 16 somente para a suíte de integração real.

## Ordem obrigatória

```bash
git submodule update --init --recursive
node scripts/check-upstream-content.mjs --materialize-symlinks
node scripts/check-upstream-pin.mjs --self-test

pnpm --dir third_party/deepseek-harness install --frozen-lockfile
pnpm --dir third_party/deepseek-harness build:official

pnpm install --frozen-lockfile --filter '@dz23-studio/*...'
pnpm build
pnpm typecheck

pnpm gate:i18n
pnpm gate:portability
pnpm gate:domain-scopes
pnpm gate:domain-routes
pnpm test:postgres-discovery
node scripts/test-postgres.mjs --list

pnpm exec vitest run --maxWorkers=1
```

Se PostgreSQL 16 estiver disponível, execute depois, com uma base descartável e credencial somente de teste:

```bash
export DZ23_POSTGRES_TEST_DSN='postgresql://USUARIO:SENHA@127.0.0.1:5432/BASE_DE_TESTE'
pnpm test:postgres
```

Nunca grave a DSN real em arquivos, logs, bundles ou commits.

## Por que essa ordem existe

1. `check-upstream-content --materialize-symlinks` converte placeholders de checkout Windows em symlinks reais e prova cada blob contra o manifesto fixado. Sem Developer Mode ele falha fechado e preserva o placeholder.
2. O Harness fixado precisa ser instalado e compilado antes do Studio. Seus pacotes locais são dependências do produto e as declarações `lib/*.d.ts` precisam existir.
3. A instalação do Studio usa `--filter '@dz23-studio/*...'` deliberadamente. Ela instala os pacotes do produto e suas dependências sem selecionar o pacote raiz `@deepseek-ai/dsh-root`, cujo `postinstall` não pertence ao bootstrap do Studio.
4. `pnpm build` compila cada pacote isoladamente pela condição `dz23-build`. Isso não substitui `pnpm typecheck`: o `tsc --noEmit` da raiz enxerga o grafo inteiro e detecta identidades nominais duplicadas que builds isolados não veem.
5. `--maxWorkers=1` é intencional. A suíte disputa PTYs, subprocessos, arquivos pequenos e limites de arquivo; paralelismo alto transforma contenção de ambiente em timeout intermitente.
6. PostgreSQL não é substituído por mocks no gate real. Sem `DZ23_POSTGRES_TEST_DSN`, os testes de integração devem permanecer explicitamente não executados, nunca chamados de verdes.

## Topologias de desenvolvimento e release

`pnpm-workspace.yaml` usa `injectWorkspacePackages: false`. No desenvolvimento, os pacotes workspace precisam compartilhar uma única identidade de tipo por symlink.

O release usa `pnpm-workspace.release.yaml` e `pnpm-lock.release.yaml`, com injeção para gerar `/opt/runtime` autocontido. Essa topologia é validada separadamente por `scripts/check-image-lock.mjs`; não copie o lock de desenvolvimento sobre o lock de release.

## Critérios de aceitação

O bootstrap só é aprovado quando:

- conteúdo e pin do upstream passam;
- instalação frozen passa sem alterar os locks;
- Harness `build:official`, Studio `build` e typecheck raiz passam;
- gates de i18n, portabilidade, escopos e rotas passam;
- suíte determinística passa com zero falhas;
- quando reivindicada durabilidade multi-instância, a suíte PostgreSQL 16 real também passa;
- `git diff --check` passa e qualquer mudança em `plugins/*/lib/**` produzida pelo build é reportada, não apagada silenciosamente.

Um build de imagem, HTTP 200, preview ou teste focado não substitui esta sequência e não prova que o produto está pronto para release.
