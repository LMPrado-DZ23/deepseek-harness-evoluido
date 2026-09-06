# Estado da missão autônoma DZ23 STUDIO

- `mission_id`: `M1-M6-finalizacao-2026-09-04`
- `objective`: integrar e provar M1-M6 com segurança, sem push, PR, deploy ou exclusões não autorizadas
- `state`: `INTEGRATING_AND_HARDENING`
- `iteration`: `2026-09-06.16`
- `started_at`: `2026-09-04 America/Sao_Paulo`
- `heartbeat_at`: `2026-09-06T15:45:00-03:00`
- `last_progress_at`: `2026-09-06T15:45:00-03:00`
- `branch`: `codex/p30-policy-foundation`
- `head`: `17e79aaab4c1ac54c1b4fc05f780f6485c5941b7`
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
- Shell M6 Windows fechado em `fd2d84a`: lifecycle WSL2, rollback, timeouts com encerramento da árvore, health obrigatório, TLS pelo hostname público e inventário fail-closed de contêineres, volumes e redes receberam GO independente. A instalação real com imagens do produto continua `NOT_EXECUTED`.
- Pin portátil do upstream e lock da cadeia de imagens foram registrados em `80d2dd7`; pin passou em clone WSL/ext4 e a verificação on-line dos digests passou.
- O verificador do pin recebeu cinco fixtures negativas reais em `bddf0ff`
  (tracked, untracked, `.gitmodules`, manifesto e origin) e uma verificação
  positiva final. O checkout Windows continua inadequado para o gate normal
  por não materializar todos os symlinks; a prova canônica permanece WSL/ext4.
- Claude entregou M3+M4+M5 em `9034a85`; transporte íntegro, mas ainda baseado em `b95d23c`. A composição sobre `d819314` foi solicitada novamente com evidência do merge-base.
- Preview recebeu o checkpoint isolado `7273b38`: instalação offline com lock congelado, 178/178 testes e build passaram em WSL/ext4. A prova de ausência usa `previewId`, portanto uma troca de `runtimeRef` não libera capacidade prematuramente.
- Retenção fail-closed foi fechada em `011f118`: nenhuma remoção física de artefatos na v1, 28/28 testes executados, 2 skips explícitos e 21/21 no namespace Linux com bind mounts reais.
- Backend PostgreSQL de capacidade foi fechado em `d243c02`: relógio do banco, bundles atômicos, quotas, fence monotônico e takeover CAS; PostgreSQL 16 descartável passou 11/11, build e lock congelado.
- Wiring PostgreSQL do Preview está isolado em `64e9686`: takeover no recovery,
  quarentena persistente no segundo reinício e bloqueio de HTTP antes do
  reconcile passaram revisão independente; 212 testes/2 skips e recorte 60/60.
  Single-active = GO; active-active = `NOT_IMPLEMENTED`.
- Conversa tenant-aware está isolada em M74-A `c7482e6`: transporte, histórico
  e autorização passaram gates próprios; M74-B continua aguardando parecer do
  Claude e não foi iniciado.
- Reconciliação segura de agentes está em fechamento isolado na M75 sobre
  `646c47b`: 122/122 focados, cobertura crítica de 100%, typecheck, builds e
  gates de contrato passaram. A suíte cumulativa teve cinco falhas de carga em
  `builder-supervisor`; os dois arquivos residuais passaram 89/89 na base
  intacta. Três processos Node separados provaram seed, recuperação e
  idempotência com o mesmo armazenamento, preservando o Git worktree. Revisão
  independente ainda será solicitada antes de qualquer merge.

## Tarefas atuais e propriedade de arquivos

- `preview capacity`: candidato isolado `64e9686` recebeu GO independente;
  integração aguarda M3–M5 por tocar o mesmo `storage-postgres/src/index.ts`.
- `retention`: fechado em `011f118` com GO independente; backend por descritor continua pré-requisito para qualquer remoção física futura.
- `M6 Windows shell`: fechado em `fd2d84a` com GO independente; lifecycle Docker Desktop real permanece `NOT_EXECUTED` enquanto a imagem M6.1 não existir.
- `M3+M4+M5`: Claude continua responsável pela ponta sobre `d819314`; Codex abriu recomposição de contingência em worktree isolado porque o inbox ainda não publicou o bundle corrigido.
- `integration/M6.1`: o self-test do pin está integrado; manifests/locks,
  runtime agregador, imagens finais, SBOM e proveniência aguardam a integração
  M3–M5 para uma única regeneração do lock.

## Testes e auditorias atuais

- preview runtime-absence: auditoria independente encontrou dois casos de troca de runtime; corrigidos e retestados, 178/178 + build + instalação offline congelada PASS. Preview distribuído ainda `NO-GO`.
- retention quarto corte: auditoria independente = `GO`; nenhuma operação física de artefato permanece ativa, e os estados projetados não são apresentados como exclusão real.
- capacity PostgreSQL: auditoria independente encontrou rollback da expiração no takeover; corrigido e reprovado em PostgreSQL 16 real, 11/11.
- M6 shell final: suíte PowerShell+Bash+Docker isolado passou; auditoria detectou e a correção fechou bypass TLS, erro de inventário mascarável e uninstall incompleto para redes/homônimos. Revisão final independente = GO.
- M3+M4+M5: a recomposição sobre `d819314` fechou os 23 domínios e 35/35 em
  PostgreSQL real; cobertura ampliada ainda precisa satisfazer D30 antes de
  auditoria e integração.
- tentativa de materializar dependências no Windows falhou com `EACCES` em links absolutos para WSL; M6.1 deve eliminar essa não portabilidade em base limpa, sem tratar o verde antigo como prova.

## Bloqueadores externos que não param o restante

- licença open source exata e política de marca;
- destino do remoto;
- SMTP real;
- domínio/Tailscale e celular físico;
- cinco participantes leigos e piloto.

## Próxima ação

1. fechar e entregar M75 para revisão independente, sem merge na principal;
2. receber o parecer do Claude sobre M74-A e M75;
3. iniciar M74-B somente depois do GO explícito da M74-A;
4. integrar somente commits aprovados e autorizados, sem excluir branches,
   worktrees ou `plugins/*/lib/**`;
5. concluir as provas de Windows/celular, fase 0.5, piloto e release mantendo os
   estados externos honestos.

## Instruções de retomada

Executar `git status`, `git rev-parse HEAD`, ler este arquivo e os finais de
`outputs/CODEX_OUTBOX.md`, `outputs/CLAUDE_INBOX.md` e
`outputs/HANDOFF_CODEX_CLAUDE.md`. Não resetar a árvore compartilhada. Consultar
os agentes vivos antes de editar `plugins/preview/**`,
`plugins/runtime-governor/**`, `deploy/windows/**` ou `tests/m6/**`.
