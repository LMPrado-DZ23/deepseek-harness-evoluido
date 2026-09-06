# P36 — Ponte segura entre o DZ23 STUDIO e conversa/agentes

Estado: **BETA**, implementação isolada em
`codex/m69-assistant-bridge-integration@f7b9c69b82abb705cb534b11d6bba28bca90db17`.
Esta prova não autoriza merge, push, deploy ou uso de provedor externo.

## O que existe

- `/studio/assistente` é uma entrada simples para o chat existente do Harness.
  Não há cópia do chat nem API inventada para criar sessão.
- O preset `dz23-assistant` expõe seis ferramentas tipadas: iniciar T2, iniciar
  sensível T3, listar, revisar, cancelar e aplicar.
- A ponte aceita somente `spawn-in-process`. Codex CLI e Claude Code continuam
  `NOT_CONFIGURED`: a configuração administrativa, o catálogo e o runtime os
  recusam antes de chamar o serviço de agentes.
- Organização, tenant, workspace, usuário e papel são derivados da sessão do
  servidor. Esses campos não existem nos argumentos controlados pelo modelo.
- Toda delegação passa pelo `StudioAgentService`: worktree isolado, diff
  verificado, orçamento, auditoria e aprovações T2/T3 são preservados.
- Runs de outro tenant, repositório, provider ou caminho permitido ficam
  invisíveis. Cancelamento só alcança o job vivo iniciado pela mesma pessoa;
  aplicar exige uma segunda aprovação T2.
- O preset não é exposto a filhos. Subagentes não podem delegar de novo usando
  a identidade herdada.
- Repositórios e linked worktrees são validados por caminho canônico, marcador
  `.git`, `HEAD`, `objects`, `refs`, descritores recíprocos e tipos de inode.
  Symlink/junction, descritor ambíguo e caminho fora da allowlist falham
  fechados.
- O Git usa índice temporário e ambiente mínimo. Hooks, fsmonitor, external
  diff, textconv, filtros clean/smudge/process, proxies e credenciais herdadas
  são neutralizados ou recusados.
- Schemas usam `additionalProperties: false`, e o mesmo contrato é conferido
  novamente no runtime.

## Ambiente da prova final

- Clone limpo em ext4 do WSL2:
  `/home/leandro/dz23-gates/m69-assistant-74446a6`.
- DeepSeek Harness fixado em
  `6c705be1ce6774a000d061da41d1823b03a3d42c`.
- Instalação com lock congelado: **PASS**.
- Build oficial do upstream e build recursivo do Studio: **PASS**.
- `pnpm typecheck`: **PASS**.
- O build regenerou somente artefatos rastreados `plugins/*/lib/**` no clone de
  prova. Eles não foram copiados para a branch de fonte nem usados para
  esconder dependência ausente.

## Testes e cobertura

Comando canônico:

```text
pnpm exec vitest run --coverage --maxWorkers=1
```

Resultado final:

- 121 arquivos aprovados; 6 arquivos de integração PostgreSQL pulados;
- 1.974 testes aprovados; 62 pulados porque `DZ23_POSTGRES_TEST_DSN` não foi
  configurado nesta prova sem Docker;
- cobertura global: 96,03% statements, 93,44% branches, 96,53% functions e
  98,10% lines;
- 100% em identidade, política, tenancy, núcleo do agente, catálogo/fechamento/
  serviço da ponte, saúde de rotas e módulos críticos do Prompt-to-App.

A interface tem suíte própria, fora do include da raiz:

```text
pnpm --dir apps/studio-web test
```

Resultado: 11 arquivos e 54 testes aprovados, incluindo
`AssistantEntry.spec.ts`.

O workflow usa exatamente `pnpm exec vitest run --maxWorkers=1`. A forma antiga
`pnpm test -- --maxWorkers=2` não repassava o argumento ao Vitest e foi
removida. O limite serial é intencional porque a suíte reúne PTY, subprocessos,
arquivos grandes e provas multiprocesso no mesmo runner.

## Gates de composição e empacotamento

- `UPSTREAM_PIN=PASS`: commit e árvore do Harness conferidos, com autoteste
  negativo.
- `PORTABILITY=PASS`: zero achados, com fixture negativa.
- `I18N_GATE=PASS`: 11 catálogos, 287 chaves e baseline sem crescimento.
- `DOMAIN_ROUTE_GATE=PASS`: 23 domínios em dois patches de produção.
- `ASSISTANT_TOOL_CATALOG=PASS`: seis ferramentas, provider exclusivo
  `spawn-in-process` e três mutações negativas.
- `ASSISTANT_PACKAGE_PROOF=PASS`: `lib` e i18n staged, manifesto/profile/root
  lock, preset, resolução do plugin e de agents, provider local exclusivo e
  recusas de extensões/drivers Git hostis.
- P37 no `git archive` de `f7b9c69`: **PASS**, 819 arquivos, 21 manifests, um
  arquivo de licença e zero achado. SHA-256 do ZIP auditado:
  `C69EA955F72BD7341454C1C56541A59DCA72D1ADE35FB90C784972C2FFF24D77`.

## Limites honestos

- Criação automática de uma sessão dedicada pelo botão: `NOT_PRESENT`.
- Codex CLI e Claude Code reais pela ponte: `NOT_CONFIGURED` e `NOT_EXECUTED`.
- A extensão M70 acrescenta equipe multiagente/DAG governada em fatia separada;
  consenso automático, aplicação automática e Hermes real continuam
  `NOT_PRESENT`. Veja `M70-governed-multiagent-team-proof.md`.
- MCP, skills e memória semântica dentro deste preset mínimo: `NOT_PRESENT`.
- Cancelamento após reinício: `BETA`, fail-closed; jobs concluídos são removidos
  do mapa em memória.
- PostgreSQL físico, Docker, navegador E2E, domínio real, celular e CI remoto:
  `NOT_EXECUTED` nesta prova.
- A suíte PostgreSQL permanece uma etapa separada do CI e não é substituída
  pelos 62 testes pulados acima.
- Não houve merge na principal, push, PR, deploy ou alteração do upstream.

## Decisão técnica

A composição, o confinamento local, o pacote, o clone limpo e o gate D30 estão
provados. P36 permanece **BETA** até uma sessão real no Harness e a prova de
runtime com PostgreSQL/Docker serem executadas. Multiagentes não faziam parte
deste checkpoint. A fatia M70 posterior adiciona sete ferramentas de equipe sem
ampliar a autoridade das seis ferramentas individuais existentes e preserva o
mesmo serviço de agentes como autoridade única para worktrees, runs, revisão e
aplicação.
