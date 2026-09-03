# Relatório técnico — DZ23 STUDIO

> Atualização de 2026-09-03 — P32/P33 fatia 2: o Prompt-to-App gera quatro
> categorias BETA sobre Next.js: apresentação, catálogo, formulário+banco e
> painel CRUD. Banco, migrações, repositórios, autenticação, sessão, CSRF,
> papéis e ações são determinísticos e protegidos do modelo. A prova de acesso
> executou 401→200 e login→criar→editar→excluir em contêiner com
> `NetworkMode=none`. Após a revisão independente, as listas de todo formulário
> exigem owner/member, códigos ficam ligados ao navegador e limitados, a saída
> do modelo passa por política AST, a verificação roda com `NODE_ENV=production`
> e o logotipo é copiado, protegido e renderizado. Foram aprovados 293 testes,
> com 94,94% de statements globais e 90,41% no núcleo Prompt-to-App; o golden
> set fechou 12/18 casos executáveis e expôs 36 critérios `NOT_AUTOMATED`, mantendo
> SaaS e dashboard como `NOT_IMPLEMENTED`. LLM real é `NOT_EXECUTED`, preview e
> publicação são `NOT_PRESENT`, e experiência leiga é `NOT_VALIDATED`. O
> fechamento verificado pelo Claude foi integrado por fast-forward local em
> `codex/p30-policy-foundation@58f77d3`; não houve push, PR ou deploy.
> Redistribuição e primeiro push continuam
> bloqueados até a licença do Studio e o inventário completo de dependências,
> incluindo `sharp`/libvips, Nodemailer, fontes, Next, Tailwind e componentes.
>
> Atualização de 2026-09-02: o histórico do PoC-01 abaixo foi preservado. A
> errata do domínio foi aceita, o PoC-01b fechou a viabilidade do núcleo e o
> P29-C comprovou a borda Caddy para HTTP, RPC e WebSocket. O resultado atual e
> seus limites estão em `docs/pocs/P29-C-edge-proof.md` e
> `docs/CAPABILITY_MATRIX.md`; nada foi implantado em produção.
>
> O P31-A está implementado em branch de revisão: PostgreSQL 16 real, 174/174
> testes, 100% de cobertura, escritor único cross-process, migração lógica e
> restauração após reinício do Harness. O relatório vinculante desta fatia é
> `docs/pocs/P31-A-storage-postgres-proof.md`; não houve merge, push ou deploy.
>
> A Fase 3 está implementada na branch `codex/fase3-agents-routes`: PoC 3A GO
> para isolamento e composição in-process, 198 testes sem PostgreSQL e 216/216
> com PostgreSQL real, ambos com 100% de cobertura da
> lógica determinística. Codex/Claude reais, provedores externos e deploy seguem
> `NOT_EXECUTED`. Relatório vinculante: `docs/pocs/P35-phase3-agents-routes-proof.md`.

Data: 2026-09-01  
Decisão do gate literal: **NO-GO**  
Viabilidade arquitetural: **PARCIALMENTE VIÁVEL, condicionada à errata do domínio e a nova prova live**

## Escopo e identidade

O Studio foi implementado em repositório separado em `C:\Users\zodyp\Documents\Codex\2026-09-01\com\work\poc-01-studio`. O upstream foi usado no checkout WSL ext4 `/home/leandro/harness-studio-poc02/deepseek-harness`, exatamente no commit:

```text
6c705be1ce6774a000d061da41d1823b03a3d42c
```

Verificação final:

```sh
git rev-parse HEAD
git status --short
git diff --stat
git diff --cached --stat
```

Resultado: o SHA coincidiu; os três comandos de estado/diff terminaram sem saída. Nenhum package do upstream foi editado ou copiado para o Studio.

## Arquitetura implementada

O manifest do profile `studio` declara, nesta ordem:

1. `@deepseek-ai/dsh-base`
2. `@deepseek-ai/dsh-web-app`

O `cordis.patch.yml` altera somente o modelo padrão para `studio-fake/studio-deterministic` e insere `@studio/hello` após as camadas oficiais.

O plugin registra:

- tool `studio_echo` com `ctx.tools.register`;
- adapter keyless em `ctx.llm.registerAdapter`, provider `studio-fake` e modelo `studio-deterministic`;
- streaming determinístico para echo, tentativa de prova de sandbox e detecção de histórico restaurado;
- schema tipado `{ tenant_id, created_at, note }` em `ctx.storageDomain`;
- fechamento explícito do domínio no ciclo de vida do plugin.

Não foram usadas chaves reais. O boot de diagnóstico gerou uma credencial efêmera local do próprio Harness; o arquivo foi descartado, está coberto pelo `.gitignore`, não foi incluído neste repositório e seus valores não foram registrados.

## Dump de configuração

Comando executado:

```sh
DSH_HOME=/mnt/c/Users/zodyp/Documents/Codex/2026-09-01/com/work/poc-01-studio/dsh-home \
DSH_TELEMETRY_DISABLED=1 \
node /home/leandro/harness-studio-poc02/deepseek-harness/apps/cli/lib/bin.js \
  --profile studio --dump-config
```

Resultado: **PASS**. O dump mostrou:

- camadas `@deepseek-ai/dsh-base` e `@deepseek-ai/dsh-web-app`;
- `agent-default-model` com `provider: studio-fake` e `model: studio-deterministic`;
- `sandbox-policy` com default `workspace-write`;
- `approval` com default `ask` para `workspace-write`;
- componentes web, inclusive `web-startup`, `webserver`, `web-runtime` e UI;
- linha final `studio-hello` / `@studio/hello`.

Approval e sandbox não foram desativados no profile.

## Testes e cobertura

Comandos finais:

```sh
/home/leandro/harness-studio-poc02/deepseek-harness/node_modules/.bin/tsc -p tsconfig.json --noEmit
node node_modules/vitest/vitest.mjs run --coverage
```

Resultados:

```text
Test Files  1 passed (1)
Tests       4 passed (4)
All files   100 statements | 100 branches | 100 functions | 100 lines
```

Os testes verificam:

1. rejeição literal de `studio.hello` pelo validador do upstream;
2. persistência e renderização do registro tipado pela tool;
3. streaming determinístico de tool, sandbox e restart no adapter;
4. montagem dos seams `storageDomain`, `tools`, `llm` e fechamento do domínio.

Esses são testes focados do plugin. O quarto usa doubles tipados do contexto e não equivale a uma sessão live do Harness.

## Gate incompatível: `studio.hello`

Evidência observada no teste:

```text
domain name 'studio.hello' must match /^[a-z][a-z0-9_]*$/
```

O nome físico compatível implementado é `studio_hello`; `studio.hello` permanece como namespace lógico/documental. Isso não satisfaz o texto literal original e, por si só, determina **NO-GO literal** sem qualquer edição no upstream.

Errata mínima recomendada para uma nova rodada:

> Usar o domínio físico `studio_hello` e o namespace lógico `studio.hello`.

Essa errata preserva o upstream sem diff e não altera a arquitetura da composição.

## Prova live não concluída

A prova planejada executaria duas inicializações do profile real: a primeira criaria a sessão, exigiria `allowed-once` para `studio_echo`, executaria `bash` sob `workspace-write` e persistiria sessão/registro; a segunda retomaria a mesma sessão e validaria o registro.

Ela **não foi concluída**. O runner externo de evidência falhou durante o carregamento com:

```text
ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-llm' imported from .../plugins/proof-runner/index.mjs
```

Causa identificada: resolução de dependência a partir do realpath do runner fora do `node_modules` do profile, após uma instalação raiz em NTFS falhar com `EACCES`. O runner de prova foi removido da composição final. Não houve sessão criada, tool live executada, auditoria live de aprovação, marcador live de sandbox, reinício de sessão ou prova de preservação do registro. Nenhuma dessas provas é afirmada como PASS.

Uma tentativa separada de executar a CLI diretamente pelo source loader também falhou antes da composição porque o JavaScript compilado de `@deepseek-ai/cordis` não exporta em runtime o `const enum` `FiberState`; o binário oficial construído do mesmo commit funcionou e foi o usado no dump.

## Segurança e artefatos

- Sem chaves reais e sem chamadas a provedores externos.
- `DSH_TELEMETRY_DISABLED=1` foi usado nos diagnósticos.
- Approval continua `ask`; sandbox continua `workspace-write`.
- A credencial efêmera gerada pelo Harness foi descartada e não integra os artefatos.
- Varredura final por indicadores `browser-session`, `grant`, `secret`, chaves com prefixo conhecido e atribuições de API key: nenhum hit nos arquivos entregáveis.
- `dsh-home/.credentials.yaml`: ausente.

## Decisão

**NO-GO literal**, por dois gates independentes:

1. o domínio físico obrigatório `studio.hello` é rejeitado pelo upstream fixado;
2. as provas live de sessão/tool/aprovação/sandbox/restart/persistência não ocorreram.

**A composição não foi invalidada como um todo.** Dump, seams, provider determinístico, schema tipado e cobertura demonstram uma base arquitetural plausível. Uma nova rodada pode ser considerada após aceitar a errata `studio_hello` físico + `studio.hello` lógico e executar o runner em ext4 com dependências resolvidas no mesmo package boundary do profile.
