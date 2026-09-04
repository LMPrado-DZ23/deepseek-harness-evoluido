# Estado da missão autônoma DZ23 STUDIO

- `mission_id`: `M1-M6-finalizacao-2026-09-04`
- `objective`: integrar e provar M1-M6 com segurança, sem push, PR, deploy ou exclusões não autorizadas
- `state`: `FIXING`
- `iteration`: `2026-09-04.4`
- `started_at`: `2026-09-04 America/Sao_Paulo`
- `heartbeat_at`: `2026-09-04T12:20:00-03:00`
- `last_progress_at`: `2026-09-04T12:20:00-03:00`
- `branch`: `codex/p30-policy-foundation`
- `head`: `50cd12b2b35d5dd274fe6648d8a8dea097762d64`
- `harness_upstream_pin`: `6c705be1ce6774a000d061da41d1823b03a3d42c`

## Critérios de aceite

- nenhum blocker interno, CRITICAL ou HIGH conhecido;
- M3, M4 e M5 compostos sobre a principal após auditoria independente;
- M6 Windows e M6.1 portabilidade/imagem implementados e provados no ambiente disponível;
- gates de tipo, build, testes, i18n, domínios, licenças e artefatos aprovados em base limpa;
- estados externos continuam honestos: celular físico, cinco leigos, piloto, SMTP real e release público não são simulados;
- upstream preservado e nenhum push, PR, deploy, segredo ou exclusão não autorizada.

## Progresso comprovado

- Trust plane, Postgres P31-A, agentes/rotas e Prompt-to-App fatias 1/2 integrados.
- M1 preview seguro e M2 categorias/Golden Set incorporados na história principal.
- Recuperação de geração, limites do builder e governador de jobs/builds integrados até `d819314`.
- Bundle transportável `outputs/CODEX_BASE_d819314.bundle` verificado, SHA-256 `413EBE67B82BB0CF9A9169CAD0FB4B48CE2C91BFD58B539D3E7415A763F836BE`.
- Shell inicial M6 registrado em `50cd12b`, mas ainda em correção; não é GO.
- Claude entregou M3+M4+M5 em `5749d6f`; auditoria Codex encontrou 14 regressões e impediu merge. Claude está regenerando uma ponta cumulativa sobre `d819314`.

## Tarefas atuais e propriedade de arquivos

- `preview capacity`: subagente Codex; somente `plugins/preview/**` e lockfile se inevitável. Primeiro corte NO-GO por cinco falhas de concorrência/recovery.
- `retention`: subagente Codex; somente `plugins/runtime-governor/src/{index,retention}.ts` e teste. Primeiro corte NO-GO por segurança de remoção, TOCTOU, quota e recovery.
- `M6 Windows shell`: subagente Codex; somente `deploy/windows/**` e `tests/m6/**`. Primeiro corte NO-GO por confinement, health, symlink e prova simulada insuficiente.
- `M3+M4+M5`: Claude; nova ponta única sobre `d819314`, corrigindo `M345_5749D6F_CODEX_PARECER.md` e os achados próprios de 15:05Z.
- `integration/M6.1`: Codex principal após os quatro trabalhos acima passarem revisão.

## Testes e auditorias atuais

- preview primeiro corte: implementação reportou 168/168 em ext4, mas auditoria independente = `NO-GO`; reteste pendente.
- retention primeiro corte: auditoria independente = `NO-GO`; reteste pendente.
- M6 shell primeiro corte: teste Node e parser PowerShell passaram, mas auditoria independente = `NO-GO`; reteste pendente.
- M3+M4+M5 `5749d6f`: não integrado; parecer = `NEEDS_FIX`.
- tentativa de materializar dependências no Windows falhou com `EACCES` em links absolutos para WSL; M6.1 deve eliminar essa não portabilidade em base limpa, sem tratar o verde antigo como prova.

## Bloqueadores externos que não param o restante

- licença open source exata e política de marca;
- destino do remoto;
- SMTP real;
- domínio/Tailscale e celular físico;
- cinco participantes leigos e piloto.

## Próxima ação

1. receber e auditar as três correções Codex;
2. receber e auditar a ponta cumulativa Claude;
3. integrar por commits verificáveis, sem aceitar exclusões de `plugins/*/lib/**`;
4. executar M6.1: pin oficial transportável, workspace/lock sem caminhos absolutos, runtime agregador, imagem multiarch e SBOM;
5. rodar gates completos serializados em WSL/ext4 e auditoria final independente.

## Instruções de retomada

Executar `git status`, `git rev-parse HEAD`, ler este arquivo e os finais de
`outputs/CODEX_OUTBOX.md`, `outputs/CLAUDE_INBOX.md` e
`outputs/HANDOFF_CODEX_CLAUDE.md`. Não resetar a árvore compartilhada. Consultar
os agentes vivos antes de editar `plugins/preview/**`,
`plugins/runtime-governor/**`, `deploy/windows/**` ou `tests/m6/**`.
