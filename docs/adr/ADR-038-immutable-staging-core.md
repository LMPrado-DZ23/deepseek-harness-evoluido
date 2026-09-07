# ADR-038 — Núcleo de staging imutável e reconciliável

Status: aceito para `STAGING_CORE_BETA` em M89.

## Contexto

O DZ23 STUDIO ainda não possui uma publicação de staging utilizável. Promover
um protótipo exige preservar a identidade exata do artefato, uma confirmação
T2, a ordem dos efeitos externos e a possibilidade de retomar depois de uma
queda. Tratar timeout como falha definitiva permitiria uma segunda publicação
enquanto a primeira ainda está acontecendo.

O `StudioRun` atual não preserva um localizador durável, SBOM e proveniência
suficientes para essa promoção. A auditoria de aprovações do Prompt-to-App
também não é uma autoridade geral de ticket T2. Portanto esta decisão define o
núcleo e mantém sua montagem fora do produto.

## Decisão

O domínio físico `studio_staging_releases` (nome lógico
`studio.staging.releases`) guarda um journal por operação. Todos os registros
carregam `org_id` e `tenant_id`; os patches Postgres roteiam o domínio
explicitamente.

Uma publicação nasce em `APPROVAL_PENDING` antes de consumir a confirmação. A
porta T2 faz claim idempotente por `release_id` e fingerprint. Exceção ou perda
da resposta mantém esse estado bloqueado para retomada; somente uma resposta
explícita `definitive-denied` registra rejeição. `provider_id` e
`target_ref` vêm da configuração do servidor. O `target_key` deriva somente do
destino físico, de modo que duas organizações não possam comandar o mesmo
alvo; a primeira reserva também vincula permanentemente esse alvo ao seu
escopo.

O repositório autoritativo deve, atomicamente:

- reservar o destino e alocar uma geração estritamente crescente;
- fazer CAS das transições e fencing do lease;
- comparar release e geração ativos antes de rollback;
- finalizar receipt e trocar o ponteiro ativo na mesma transação;
- colocar o destino em quarentena diante de efeito externo conflitante, com
  fencing que nunca substitui o owner de uma geração mais nova já em voo.

Depois que o provider pode ter recebido a chamada, uma resposta inconclusiva
nunca vira `FAILED`. O journal fica `RECONCILIATION_REQUIRED`; o status aceita
somente `READY` com receipt completo ou `UNKNOWN`. `UNKNOWN` mantém o destino
bloqueado. O receipt precisa repetir provider, destino, operação, tipo, geração
e hash do artefato. Ordem causal usa a geração e o relógio do Studio, nunca o
relógio do provider.

Rollback é uma nova geração que republica um artefato imutável anterior. Ele
não apaga histórico nem recursos externos. O schema aceita exclusivamente o
ambiente literal `staging`; produção não é representável por esta API.

## Limites

- As garantias transacionais são um contrato de porta e estão provadas por um
  repositório determinístico em memória; adapter Postgres real ainda não existe.
- Provider, rede, credencial, rota HTTP, botão e montagem no runtime estão
  `NOT_CONFIGURED` / `NOT_EXECUTED` / `NOT_PRESENT`.
- A origem durável do artefato e a autoridade T2 de serviço ainda precisam ser
  implementadas antes de integrar este núcleo.
- `STAGING_CORE_BETA` não significa que o produto publica em staging.

## Evidência exigida para integração

- adapter Postgres com transações concorrentes reais e reinício;
- ticket T2 autoritativo e idempotente;
- store de artefatos imutáveis com verificação de todos os hashes;
- provider de staging com idempotência, receipt e reconciliação comprovados;
- jornada HTTP/UI e rollback em ambiente descartável, sem produção.
