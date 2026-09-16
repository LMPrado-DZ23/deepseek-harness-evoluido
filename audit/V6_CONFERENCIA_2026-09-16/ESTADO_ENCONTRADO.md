# Estado encontrado — conferência do MASTER V6 contra o código

> Esta é a **fotografia antes de qualquer correção desta rodada**, como o Prado
> pediu. Ela não refaz o projeto, não amplia escopo e não apaga histórico.

## 1. O que foi conferido

| item | valor |
| --- | --- |
| diretório | `/home/claude/integ` |
| branch | `integ` |
| HEAD no momento da conferência | `f656827` (OS-98) |
| árvore de trabalho | **limpa** (nenhuma alteração staged ou não staged) |
| submódulo upstream | `6c705be1ce6774a000d061da41d1823b03a3d42c`, zero diff |
| baseline real | `1336c4a` (OS-97) → `88b5919` (preparo open source) → `f656827` (OS-98). **Não** foi suposto `HEAD~1` |

Especificação ativa, com hash conferido contra o `SHA256SUMS.txt` do próprio pacote:

| arquivo | SHA-256 | confere |
| --- | --- | --- |
| `PROMPT_MASTER_DZ23_V6.txt` | `b713d0e9…bf4d21` | SIM |
| `docs/02_MATRIZ_DE_REQUISITOS.json` | `6294921d…5871c162` | SIM |
| `docs/03_CENARIOS_DE_ACEITE.json` | `3b3c10a5…cc60088f` | SIM |

`fontes/` foi tratado como histórico, não como instrução concorrente, conforme a
instrução do Prado.

## 2. O achado que governa esta conferência

**Dos 110 IDs da matriz V6, apenas 12 (`EVO-01`…`EVO-12`) aparecem em algum
lugar deste repositório.** Os outros 98 — `UX`, `GEN`, `ENG`, `AGT`, `INT`,
`DAT`, `OPS`, `SEC`, `QA`, `REL`, `BUS` — não são citados em nenhum documento,
portão, teste ou comentário.

Isso **não** significa que não estejam implementados: o repositório mantém o
próprio livro mestre, com 257 requisitos e IDs próprios, e muita coisa da V6
está lá com outro nome. Significa outra coisa, e é a resposta à pergunta do
Prado: **não existia rastreabilidade entre a matriz V6 e este código.** Ninguém
podia dizer, antes desta conferência, quanto do MASTER estava coberto — porque
nada ligava um lado ao outro. É isso que `MATRIZ_CONFERIDA.json` passa a ligar.

## 3. O que a leitura do código encontrou

| implementação | quantos | o que quer dizer |
| --- | --- | --- |
| `IMPLEMENTADA` | 25 | código de produção satisfaz o aceite mínimo e está ligado ao runtime |
| `PARCIAL` | 52 | parte existe; a lacuna está nomeada, uma a uma, na matriz |
| `AUSENTE` | 32 | não há código de produção correspondente |
| `AUSENTE_EM_RUNTIME` | 1 | o código existe inteiro e **não está montado** (ver 3.1) |

### 3.1 O defeito mais grave: a parada de emergência não existe em execução

`AGT-05`. O plugin `@dz23-studio/emergency-stop` está completo — domínio,
serviço, rotas, tela em `apps/studio-web/src/EmergencyStop.tsx`, testes — e é
dependência declarada em `dsh-home/profiles/studio/package.json`.

**Ele não é montado em nenhum perfil.** `dsh-home/profiles/studio/cordis.patch.yml`
monta dezessete linhas e nenhuma delas é o `emergency-stop`. Os três
consumidores (`agents`, `integration-hub`, `prompt-to-app`) resolvem o serviço
com `ctx.get('studioEmergencyStop')` e **seguem em frente quando ele é
`undefined`** — a falha é aberta, e o comentário no código diz que isso é de
propósito, porque "o botão de emergência é opcional no perfil".

O efeito: no perfil publicado, a tela mostra o painel, as rotas `/emergency-stop*`
não existem, e nenhuma execução é bloqueada. **O controle de segurança que o
README anuncia como "visível o tempo todo" é decorativo em runtime.**

### 3.2 O padrão que atravessa a fatia V6 já entregue (E0–E4)

Das 12 alegações `EVO-01…EVO-12` registradas no livro mestre como entregues,
**apenas `EVO-01` tem chamador de produção** — e mesmo esse é um portão de CI,
não o produto em execução. Os outros são funções puras com suíte própria,
dentro de um plugin que está montado mas que **não as exporta nem as importa**:

| módulo | único importador |
| --- | --- |
| `plugins/prompt-to-app/src/brand-package.ts` | `tests/brand-package.spec.ts` |
| `plugins/prompt-to-app/src/brand-apply.ts` | `tests/brand-apply.spec.ts` |
| `plugins/prompt-to-app/src/execution-profiles.ts` | `tests/execution-profiles.spec.ts` |
| `plugins/prompt-to-app/src/visual-edit.ts` | `tests/visual-edit.spec.ts` |
| `plugins/prompt-to-app/src/handoff.ts` | `tests/handoff.spec.ts` |
| `plugins/prompt-to-app/src/component-exit.ts` | `tests/component-exit.spec.ts` |
| `plugins/prompt-to-app/src/research.ts` | **ninguém**, nem teste |

Teste passando ali é evidência sobre a função, **não sobre o produto**. As
entregas OS-83 a OS-87 são reais como decisão e como lógica; elas não são
capacidade operacional, e o livro mestre não dizia isso com esta clareza.

### 3.3 O Modo Empresa não existe

`BUS-01`…`BUS-24`: **22 AUSENTE, 2 PARCIAL**, e os dois parciais são mecanismos
genéricos que não são de negócio (a marca por empresa, sem chamador; e a
aprovação atômica de uso único, que não é mandato).

Não há entidade "empresa", nem plano de negócio, oferta, precificação,
provisionamento, lançamento, CRM, campanha, venda, checkout, pagamento,
atendimento, entrega, conciliação financeira, operação por objetivos, equipe de
negócio, relato, pacote, portfólio, fiscal, tela de Modo Empresa, pausa/saída
nem piloto ponta a ponta. `plugins/` tem vinte plugins e **nenhum** é de
negócio.

### 3.4 Outros achados de montagem

- **`SEC-01`** — o isolamento por linha no banco (RLS) **não está ligado no
  runtime**: nenhum perfil define `tenantRuntimeDsnRef` nem
  `storageAuthority: 'rls'`, então os oito repositórios tenant-aware ficam sem
  chamador e os demais domínios seguem em KV opaco. O trabalho existe; a chave
  que o liga, não.
- `dz23-studio-storage-postgres` só existe no overlay `deploy/harness/edge.patch.yml`.
  Quem rodar o perfil `studio` sem esse patch fica em backend JSON.
- `dz23-studio-prompt-to-app` recebe no perfil um bloco `builder: {…}` que não
  corresponde a nenhum campo da configuração real (`builderLifecycle`):
  configuração que parece ter efeito e não tem.

## 4. O que ESTA execução alterou (e o que não alterou)

Esta sessão entregou `88b5919` (preparo para código aberto) e `f656827`
(OS-98: troca da interface principal pelo workspace aprovado e aplicação da
marca do proprietário). Os IDs V6 tocados por ela são `UX-01`, `UX-02`, `UX-05`,
`UX-06`, `UX-07`, `UX-08`, `UX-09`, `QA-03`, `REL-01`, `REL-03` e `REL-04` —
todos marcados `ALTERADO_NESTA_EXECUCAO` na matriz.

**Nada de engenharia, Modo Empresa, Cherry ou refinamento V6 foi alterado nesta
execução.** A decisão de layout e de logo complementou o MASTER; ela não o
cumpriu, e este documento é o que diz isso com número.

## 5. Provas executadas nesta versão (`f656827`)

Não são testes históricos: foram executados nesta árvore, neste commit.

| verificação | resultado | comando |
| --- | --- | --- |
| 24 portões estáticos | **todos `EXIT=0`** | `pnpm gate:*` |
| constituição | **PASS**, 14 cláusulas, 38 vereditos | `node scripts/check-constitution.mjs --verdicts /tmp/verdicts.txt` |
| suíte raiz | **3751 passaram, 68 pulados** (213 arquivos) | `pnpm -w test` |
| suíte studio-web | **525 passaram** (47 arquivos) | `pnpm exec vitest run` |
| e2e navegador | **119 passaram, 3 pulados**, quatro tamanhos | `pnpm exec playwright test` |
| PostgreSQL 16 real | **65/65**, `POSTGRES_GATE=PASS` | `pnpm -w test:postgres` |
| capturas reais | 10 imagens do produto | `node scripts/capture-screenshots.mjs` |

O que esses números **não** provam, e é preciso dizer: eles não certificam
integração com modelo real (`EB-04`), não provam Modo Empresa (não existe), e
não substituem os aceites da matriz V6 — a maior parte dos quais está
`NOT_RUN` porque não há o que executar.

## 6. Conclusão alegada × conclusão comprovada

| alegação anterior | o que a conferência mostra |
| --- | --- |
| "E0–E4 da V6 entregues (OS-83…OS-87)" | a lógica existe e tem teste; **11 dos 12 módulos não têm chamador de produção** |
| "a interface principal é o workspace aprovado (OS-98)" | **confirmado** — `UX-01` IMPLEMENTADA, com captura real e e2e nos quatro tamanhos |
| "a marca do proprietário foi aplicada" | **parcialmente** — original preservado e derivados no produto; **não há variante dark nem teste de identidade em tamanho pequeno** |
| "parada de emergência preservada" | **falso em runtime** — o plugin não é montado |
| "isolamento por inquilino provado em PostgreSQL real" | os testes passam contra o banco; **o caminho RLS não está ligado em nenhum perfil** |
| "produto v1.0 candidata" | sustentável para o Prompt-to-App; **não** para o MASTER V6, que tem 32 requisitos AUSENTE e 52 PARCIAL |

**Nenhum marco da V6 está concluído.** O que está concluído é a fatia de
apresentação (OS-98) e as capacidades próprias do Studio já registradas no livro
mestre do repositório.
