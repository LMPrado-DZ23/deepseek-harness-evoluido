# Candidata cumulativa de integração — 07/09/2026

Base: `codex/m89-immutable-staging@f1677b4d46555ef7c2fa8d732e5c6dda38227461`.
**A principal antiga em `17e79aa` permanece preservada e não recebeu merge.**
Autor: Claude (Opus 5).

## O que entrou, e em que ordem

| Passo | Origem | Como |
| --- | --- | --- |
| 1 | `claude/m90a-action-approval@9397626` | avanço direto — descende de M89 |
| 2 | `claude/m75b-external-worker@90713a7` | merge (base comum `646c47b5`) |
| 3 | `claude/m74a-bind-hardening@af1da10` | merge (base comum `646c47b5`) |

O conteúdo reunido: M73 + M74-A corrigida + M74-B (transporte e tela) + M91
(compactação) + M75-B (encerramento comprovado) + M90-A (autoridade de
confirmação) + M72-A (PostgreSQL real e RLS provada).

## Conflitos, e como foram resolvidos

Seis, todos identificados e resolvidos à mão. **Nenhum foi resolvido por
"aceitar o meu lado" cego.**

- `audit/AUTONOMOUS_MISSION_STATE.md` e `docs/audit/AUTONOMOUS_MISSION_STATE.md`
  — cabeçalho de estado: manteve-se o da linha M89, que é mais recente. A fila
  de ações do ramo M75 já tinha sido cumprida pelos pareceres emitidos.
- `scripts/prove-edge.mjs` — a linha M89 tem as asserções de saída segura
  (M80/M82) e é superconjunto do que o ramo M74 afirmava. Manteve-se M89.
- `docs/CAPABILITY_MATRIX.md` — manteve-se a matriz de M89 (mais linhas) e
  então ela foi **corrigida**: a linha
  "Conversas do Assistente em instalação multiusuário | **NOT_SUPPORTED**"
  deixou de ser verdade, porque é exatamente o que M74-A/M74-B entregam. Passou
  a `BETA`, dizendo explicitamente que o **cliente do Harness** continua sem
  suporte a várias pessoas — quem passou a servir a conversa é o Studio.
- `apps/studio-web/src/styles.css` — os dois lados só acrescentavam blocos
  distintos ao fim da folha. União.
- `plugins/identity/tests/http.spec.ts` — dois testes diferentes colados pelo
  mesmo fechamento. União: os dois sobrevivem.

## Gates executados sobre a candidata

Container Linux, PostgreSQL 16.13 real, Harness no pin
`6c705be1ce6774a000d061da41d1823b03a3d42c`; **nenhum arquivo rastreado do
submódulo modificado** e o gitlink aponta exatamente para o pin.

- `tsc --noEmit` **PASS**
- `pnpm build` **PASS**
- suíte raiz **com PostgreSQL habilitado**: **2198 aprovados**, 3 reprovados
- `apps/studio-web`: 19 arquivos, **103 testes PASS**
- coverage: statements 95,75% · branches 92,94% · functions 95,63% ·
  lines 97,90% — **zero violação de limiar**
- `I18N_GATE=PASS` (15 catálogos, 290 chaves)
- `DOMAIN_ROUTE_GATE=PASS domains=26 files=2`
- domain-scopes **PASS** · `PORTABILITY=PASS findings=0`
- `ASSISTANT_TOOL_CATALOG=PASS tools=13` com as três mutações negativas

As 3 reprovações são as guardas de permissão POSIX do `builder-supervisor`
derrotadas pelo **uid 0** do container. Como usuário sem privilégio, esses
mesmos três arquivos passam **103/103**. Não são desta integração.

`check-upstream-content` reprova **neste diretório específico** porque o
submódulo aqui foi copiado já compilado e tem artefatos `.dsh-build/` que não
existem na árvore fixada. Num clone limpo o mesmo gate passa com
`entries=8953 sha256=862b92782c2f5cd67f81debd1116b16150dfafd84fb4ce2602a729f9cf3d26dc`,
idêntico ao registrado pelo Codex no M89. **Isto é limitação do meu diretório
de trabalho, não da candidata** — e por isso está escrito aqui em vez de
omitido.

## O que esta candidata NÃO é

- **Não** foi mesclada na principal. **Não** houve push, PR nem deploy.
- **Não** contém prova de Docker, Windows nativo, celular físico, domínio real,
  SMTP real nem fase 0.5 com cinco pessoas leigas.
- `pnpm-lock.release.yaml` continua defasado: **a imagem de release ainda não
  contém M90 nem esta integração.**
- `plugins/*/lib/**` foi reconstruído por `pnpm build` neste diretório e ficou
  **fora** do commit de merge: são artefatos de build. Nada foi apagado nem
  desrastreado.

## P37 — inventário de licenças e proibições (07/09/2026)

`check-release-licenses.mjs --self-test` → **PASS**: o gate reprova artefato
vazio, dependência proibida (`freestyle`) e assinatura de código proibido. Um
gate que passa com zero itens é uma falha, e este prova que não é o caso.

Rodado contra a **superfície publicável** montada a partir da candidata —
`plugins/*/{lib,i18n,package.json}`, `apps/studio-web/dist`, `package.json`,
`LICENSE.md` e `UPSTREAM.lock`:

```
status = PASS · files_scanned = 464 · package_manifests = 19
license_files = 1 · findings = 0
```

**O que isto não é:** não é a imagem de release. A imagem exige Docker, que
continua `BLOCKED_EXTERNAL` sem autorização do Prado. O que foi varrido é
exatamente o que os pacotes do Studio publicam (`files: ["lib", "i18n"]`) mais a
interface compilada — e nada além disso. `pnpm-lock.release.yaml` continua
defasado, então **a imagem de release ainda não contém esta candidata**.
