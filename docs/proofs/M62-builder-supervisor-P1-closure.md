# M6.2 — Fechamento dos bloqueios P1 do builder-supervisor

**Base revisada:** `codex/m62-builder-supervisor@86a9874`
**Contrato vinculante:** `outputs/M62_CONTRACT_REVIEW_655b237.md`
**Escopo:** somente `plugins/builder-supervisor`; upstream, Compose,
Prompt-to-App e demais worktrees não foram alterados.

## Resultado

Os bloqueios apontados na revisão independente de `86a9874` foram fechados na
fundação do supervisor:

- a exportação aceita somente `.next/standalone/**`, `.next/static/**`,
  `public/**` e `evidence/appspec-report.json`; o archive é recebido e escrito
  em streaming, revalidado sem seguir links e publicado por rename atômico;
  hash e verificação usam a mesma ordem canônica de nomes;
- staging órfão é renomeado para quarentena e removido antes da retenção;
  número total e bytes físicos dos exports são limitados globalmente;
- replay RPC persiste a resposta completa. Mesmo `request_id` e mesmo corpo
  devolvem a resposta gravada; corpo divergente conflita. O mutex cobre apenas
  metadados, não a operação, e falhas transitórias não envenenam a nova
  tentativa. Resultados concluídos têm retenção e capacidade limitadas;
- o namespace durável do replay deriva de `instance_id` + `policy_sha256`;
  claims de `build_id` ativos são permanentes, concluídos têm retenção, e o
  `FileBuildIdGuard` passou a ser dependência obrigatória da composição;
- `preflight` atesta exatamente `state`, `protocol_version: 1`, `instance_id`,
  `image_id` e `policy_sha256`. O store é versionado por instalação e seu
  conteúdo real é recalculado dentro de verificador isolado;
- `listManaged` reconcilia o registro com containers/volumes reais. Rollback,
  cancel e finish usam cleanup limitado com sinal novo; export publicado é
  preservado enquanto `cleanup_pending`, e o claim só conclui depois de zero
  recurso confirmado;
- wait, logs em follow e download de archive são governados pelo prazo da
  etapa, não pelo timeout curto de chamadas de controle. Escritas parciais são
  completadas ou falham fechadas;
- o limite de logs é combinado em bytes. O wire usa `test`; o resultado inclui
  `termination_reason` e coerência entre timeout/output-limit/exit code;
- o socket Unix fecha o servidor em falha de setup, revalida dev/ino/uid antes
  de remover, usa PID + start ticks contra reutilização de PID e não deixa lease
  presa quando acquire/setup falha.

## Gates executados

### Linux limpo em ext4 (WSL2)

- `tsc -p plugins/builder-supervisor/tsconfig.build.json --noEmit`: **PASS**.
- `tsc -p plugins/builder-supervisor/tsconfig.build.json`: **PASS**.
- Vitest focado com coverage: **188/188 PASS**, 7/7 arquivos de teste.
- Fronteiras críticas com **100% statements / branches / functions / lines**:
  `docker-adapter.ts`, `docker-engine.ts`, `export-artifact.ts`,
  `persistent-replay.ts`, `service.ts` e `unix-server.ts`.
- Cobertura global do pacote: 98,70% statements, 98,24% branches, 99,65%
  functions e 99,51% lines.

### Windows nativo

- Vitest focado: **144 PASS / 44 SKIP**; os 44 são testes Unix/Linux.
- Typecheck focado: **PASS**.
- Build focado: **PASS**.

### Integridade e portabilidade

- `check-portability.mjs --self-test`: **PASS**, inclusive fixture negativa.
- `check-upstream-pin.mjs --self-test`: **PASS**, 5 fixtures negativas e pin
  `6c705be1ce6774a000d061da41d1823b03a3d42c`.
- `check-upstream-content.mjs`: **PASS**, 8.953 entradas, SHA-256
  `862b92782c2f5cd67f81debd1116b16150dfafd84fb4ce2602a729f9cf3d26dc`,
  executado em clone ext4 intocado.
- `git diff --check`: **PASS**.
- `third_party/**`: **zero diff**.

## Limites honestos da prova

- A suíte raiz foi tentada em Windows e em clone ext4. Ela não constitui um
  gate válido nesses ambientes isolados porque o bootstrap do pnpm usa dependências
  workspace injetadas antes de os `lib/` do upstream existirem; a execução
  raiz termina em resolução de pacotes do Harness. O pacote alterado permaneceu
  verde dentro dessas execuções, mas a tentativa raiz **não é reportada como
  PASS**. O gate vinculante desta fatia é o pacote isolado acima.
- O gate P37 não existe nesta branch (`check-release-licenses.mjs` ausente),
  portanto está **NOT_PRESENT**, não executado.
- Docker real, `supervisor-main`, imagem, Compose e ligação com Prompt-to-App
  são a próxima fatia e permanecem **NOT_EXECUTED/NOT_PRESENT** aqui.
- Nenhum merge, push, PR ou deploy foi feito.
