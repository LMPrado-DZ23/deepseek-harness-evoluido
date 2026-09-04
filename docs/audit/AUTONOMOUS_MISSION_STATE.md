# Estado da missão autônoma DZ23 STUDIO

- `mission_id`: `M1-M6-finalizacao-2026-09-04`
- `objective`: integrar e provar M1-M6 com segurança, sem push, PR, deploy ou exclusões não autorizadas
- `state`: `INTEGRATING`
- `iteration`: `2026-09-04.10`
- `started_at`: `2026-09-04 America/Sao_Paulo`
- `heartbeat_at`: `2026-09-04T15:09:22-03:00`
- `last_progress_at`: `2026-09-04T15:09:22-03:00`
- `branch`: `codex/p30-policy-foundation`
- `head`: `fd2d84a`
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
- Claude entregou M3+M4+M5 em `9034a85`; transporte íntegro, mas ainda baseado em `b95d23c`. A composição sobre `d819314` foi solicitada novamente com evidência do merge-base.
- Preview recebeu o checkpoint isolado `7273b38`: instalação offline com lock congelado, 178/178 testes e build passaram em WSL/ext4. A prova de ausência usa `previewId`, portanto uma troca de `runtimeRef` não libera capacidade prematuramente.
- Retenção fail-closed foi fechada em `011f118`: nenhuma remoção física de artefatos na v1, 28/28 testes executados, 2 skips explícitos e 21/21 no namespace Linux com bind mounts reais.
- Backend PostgreSQL de capacidade foi fechado em `d243c02`: relógio do banco, bundles atômicos, quotas, fence monotônico e takeover CAS; PostgreSQL 16 descartável passou 11/11, build e lock congelado.
- Wiring PostgreSQL do Preview está isolado em `46d87db`: takeover no recovery e lease terminal destacada passaram 208 testes/2 skips; single-active = GO, active-active = `NOT_IMPLEMENTED`.

## Tarefas atuais e propriedade de arquivos

- `preview capacity`: candidato isolado `46d87db` fechado tecnicamente e sob auditoria independente; integração aguarda M3–M5 por tocar o mesmo `storage-postgres/src/index.ts`.
- `retention`: fechado em `011f118` com GO independente; backend por descritor continua pré-requisito para qualquer remoção física futura.
- `M6 Windows shell`: fechado em `fd2d84a` com GO independente; lifecycle Docker Desktop real permanece `NOT_EXECUTED` enquanto a imagem M6.1 não existir.
- `M3+M4+M5`: Claude continua responsável pela ponta sobre `d819314`; Codex abriu recomposição de contingência em worktree isolado porque o inbox ainda não publicou o bundle corrigido.
- `integration/M6.1`: Codex principal após os quatro trabalhos acima passarem revisão.

## Testes e auditorias atuais

- preview runtime-absence: auditoria independente encontrou dois casos de troca de runtime; corrigidos e retestados, 178/178 + build + instalação offline congelada PASS. Preview distribuído ainda `NO-GO`.
- retention quarto corte: auditoria independente = `GO`; nenhuma operação física de artefato permanece ativa, e os estados projetados não são apresentados como exclusão real.
- capacity PostgreSQL: auditoria independente encontrou rollback da expiração no takeover; corrigido e reprovado em PostgreSQL 16 real, 11/11.
- M6 shell final: suíte PowerShell+Bash+Docker isolado passou; auditoria detectou e a correção fechou bypass TLS, erro de inventário mascarável e uninstall incompleto para redes/homônimos. Revisão final independente = GO.
- M3+M4+M5 `9034a85`: não integrado; bundle íntegro, base incorreta e parecer final `NEEDS_FIX` com 13 itens ainda abertos.
- tentativa de materializar dependências no Windows falhou com `EACCES` em links absolutos para WSL; M6.1 deve eliminar essa não portabilidade em base limpa, sem tratar o verde antigo como prova.

## Bloqueadores externos que não param o restante

- licença open source exata e política de marca;
- destino do remoto;
- SMTP real;
- domínio/Tailscale e celular físico;
- cinco participantes leigos e piloto.

## Próxima ação

1. receber e auditar o primeiro candidato M3–M5 completo, seja Claude ou a contingência Codex;
2. integrar por commits verificáveis, sem aceitar exclusões de `plugins/*/lib/**`;
3. compor `46d87db` e resolver manualmente o wiring compartilhado do `storage-postgres`;
4. executar M6.1: workspace/lock portátil, runtime agregador, imagem multiarch e SBOM;
5. rodar gates completos serializados em WSL/ext4 e auditoria final independente;
6. somente então executar lifecycle Windows real com as imagens produzidas.

## Instruções de retomada

Executar `git status`, `git rev-parse HEAD`, ler este arquivo e os finais de
`outputs/CODEX_OUTBOX.md`, `outputs/CLAUDE_INBOX.md` e
`outputs/HANDOFF_CODEX_CLAUDE.md`. Não resetar a árvore compartilhada. Consultar
os agentes vivos antes de editar `plugins/preview/**`,
`plugins/runtime-governor/**`, `deploy/windows/**` ou `tests/m6/**`.
