# M89 — Núcleo de staging imutável

## Objetivo

Construir o contrato governado de promoção para staging sem publicar nada e sem
alterar o fluxo Prompt-to-App, Identity, M72 ou M74. O núcleo só poderá declarar
`STAGING_OK` depois de um provider devolver um receipt estrito para o mesmo
artefato, destino e identificador idempotente.

## Evidência de entrada

- base: `codex/m88-windows-contract-coverage@2f2a772d98d9`;
- permissão existente: `project.publish_staging`;
- fonte elegível futura: projeto `VERIFIED_PROTOTYPE` e run `PASSED` na etapa
  `verify`;
- lacuna confirmada: `StudioRun` preserva `artifact_sha256`, mas não preserva o
  localizador durável do `ExportedArtifact`, SBOM ou proveniência;
- lacuna confirmada: não existe autoridade geral de tickets T2 para serviços
  HTTP; `StudioApproval` é auditoria, não prova de confirmação humana.

## Contrato desta fatia

1. Novo domínio físico `studio_staging_releases` e nome lógico
   `studio.staging.releases`, com um único journal autoritativo por release.
2. Estados verdadeiros e monotônicos:
   `APPROVAL_PENDING → REQUESTED → STAGING → STAGING_OK`, ou `FAILED` /
   `RECONCILIATION_REQUIRED`; rollback usa
   `ROLLBACK_REQUESTED → ROLLING_BACK → ROLLED_BACK`.
3. Ator com sessão obrigatória e autorização exata
   `project.publish_staging`; viewer é recusado.
4. Ticket T2 de uso único consumido por uma porta estreita. O serviço nunca
   aceita `approved: true`.
5. Artefato de entrada opaco e já selado, ligado ao projeto/run e acompanhado
   por hashes de manifesto, aceite, SBOM, proveniência, imagem do builder e
   policy. Caminhos fornecidos pelo cliente não fazem parte do contrato.
6. `provider_id` e `target_ref` vêm exclusivamente da configuração do servidor.
7. O journal nasce em `APPROVAL_PENDING` **antes** do consumo T2. A porta de
   aprovação faz claim idempotente por release + fingerprint; crash e retomada
   nunca consomem uma segunda autoridade silenciosa. Resposta perdida mantém o
   claim pendente; somente negação explícita vira rejeição terminal.
8. `operation_id` + fingerprint fornece replay idempotente. Mesmo id com outro
   pedido é conflito. A reserva é global pelo destino físico canônico, vincula
   esse destino a um único escopo e aloca uma geração crescente.
9. Toda mutação do mesmo destino tem exclusão transacional. Rollback compara,
   na própria reserva, o release e a geração ativos; não usa uma leitura
   anterior como autoridade.
10. Lease expirada permite somente reconciliação ou retomada pré-efeito. Nunca
    libera o destino nem autoriza um segundo efeito.
11. Efeito externo inconclusivo nunca vira `FAILED`: fica
   `RECONCILIATION_REQUIRED` e só `status()` do provider resolve.
12. Ausência eventual não prova falha: o status admite apenas `READY` ou
    `UNKNOWN`. `UNKNOWN` mantém o destino bloqueado; um futuro adapter só poderá
    liberar por prova linearizável de “nenhum efeito”.
13. Receipt completo precisa repetir provider, destino, operação, tipo, geração
    e digest. Finalização e troca do ponteiro ativo são uma transação. Uma
    quarentena atrasada usa fencing e preserva qualquer geração mais nova já em
    voo. Produção não é um destino aceito pelo schema.
14. O relógio do provider é apenas observação. Ordem causal e versão ativa usam
    geração alocada no servidor; `finished_at` vem do relógio do Studio.
15. Rollback republica um artefato anterior imutável, preserva toda a história
    e nunca remove recursos externos.

## Fora desta fatia

- rota HTTP, botão, profile ou montagem no runtime;
- adaptação de `run_directory` como artefato de staging;
- provider real, Docker, rede, credencial, deploy ou publicação;
- alteração de `StudioRun`, reservada para a coordenação com M72;
- afirmação de que staging está funcional no produto.

## Execução

1. Implementar schemas e domínio.
2. Implementar fingerprint canônico e validação de receipts.
3. Implementar serviço com reserva atômica, CAS, publicação, rollback e
   reconciliação.
4. Cobrir autorização, isolamento cross-tenant, replay concorrente, conflito,
   exclusão global por destino, lease, claim T2 retomável, receipt divergente,
   efeito tardio, quarentena, falha ambígua, reconciliação e rollback.
5. Rodar build focado, testes focados, typecheck, suíte completa e P37.
6. Submeter commit fechado à revisão independente do Claude; não fazer merge,
   push, PR ou deploy.

## Gate

GO desta fatia significa apenas `STAGING_CORE_BETA`: contrato e lógica provados
com portas determinísticas. Provider real e experiência final permanecem
`NOT_CONFIGURED` / `NOT_EXECUTED` / `NOT_PRESENT`.
