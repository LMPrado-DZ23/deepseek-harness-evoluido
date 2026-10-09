# ADR-039 — Autoridade genérica de confirmação de ações sensíveis

- Estado: Aceita
- Data: 2026-09-07
- Numero compartilhado com: ADR-039-tenant-aware-assistant-transport
- Autor: Claude (Opus 5), a partir do contrato M90-A em `outputs/M90_HANDOFF_CLAUDE_20260907.md`

## Contexto

Cada fatia que precisava de confirmação humana vinha inventando a sua. O
Integration Hub tem a dele; o staging declarou um `StagingApprovalPort` sem
implementação; a M75 e a M72 vão precisar do mesmo. Repetir esse mecanismo é
repetir a chance de errar num lugar onde errar significa executar uma ação
sensível que ninguém confirmou.

Pior: onde a confirmação nasce do lado do cliente, ela não é confirmação — é o
cliente afirmando que confirmou.

## Decisão

Existe **um** domínio durável, `studio_action_approvals`, e **uma** autoridade,
`plugins/action-approval`, que não conhece nenhuma fatia específica.

1. **Quem cria o pedido é o servidor.** O descritor — ator, escopo, nível,
   ação, sujeito, fingerprint da carga, `request_id` e prazo — é derivado por um
   serviço interno confiável. **Não existe rota pública de criação.** O teste de
   roteamento prova essa ausência para todo método e toda forma do prefixo.
2. **O cliente só confirma, nega ou lê.** Ele nunca envia nível, ação, sujeito,
   fingerprint nem `approved: true`. Um corpo tentando decidir tudo isso é lido
   com teto, descartado e ignorado — e há teste que confirma que o registro não
   foi contaminado.
3. **Identidade vem de Identity + Tenancy.** Usuário, sessão, organização e
   inquilino saem da sessão do servidor; CSRF é exigido em POST.
4. **T3 exige passkey recente na mesma sessão.** A ausência falha fechada e
   **não consome** o pedido: a pessoa confirma depois de usar a chave.
5. **Consumo durável e idempotente** por `approval_id + claim_id + fingerprint`.
   O replay exato devolve o mesmo recibo, inclusive depois de recriar o serviço
   sobre o mesmo armazenamento. Reivindicação, escopo, ação, sujeito, nível ou
   fingerprint divergente recusa — fechado, nunca aberto.
6. **Erro de armazenamento continua erro.** Nunca vira "aprovado" nem "negado".
   Só a recusa explícita da pessoa é definitiva.
7. **Id determinístico** por escopo + `request_id`. Reusar o `request_id` com
   descritor diferente é **conflito**, não sobrescrita.

## Consequências

- O adaptador do staging (`plugins/staging/src/approval-adapter.ts`) mapeia
  `releaseId -> claimId` e **sanitiza** o recibo genérico para o
  `stagingApprovalReceiptSchema`, que é estrito. A direção da dependência é uma
  só: `action-approval` **não importa** staging, e não vai importar.
- Esta fatia **não monta** o plugin em nenhum perfil. Serviço e handler são
  provados diretamente. Montagem é decisão de outra fatia.
- O fingerprint **não** atravessa para o cliente: ele é o vínculo entre a
  confirmação e a carga exata da ação e não tem utilidade nenhuma na tela.

## Alternativa recusada

Deixar cada fatia com o seu próprio mecanismo. Recusada porque multiplica a
superfície onde uma ação sensível pode ser executada sem confirmação real, e
porque nenhuma delas teria consumo durável idempotente — o replay exato
executaria duas vezes.
