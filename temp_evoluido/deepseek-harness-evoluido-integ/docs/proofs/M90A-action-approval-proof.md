# Prova M90-A — autoridade durável de confirmação T2/T3

Base: `codex/m90-action-approval@4c44218` (= M89 `f1677b4` + bootstrap).
Autor: Claude (Opus 5) — 07/09/2026. Contrato: `outputs/M90_HANDOFF_CLAUDE_20260907.md`.
ADR: `docs/adr/ADR-039-generic-action-approval-authority.md`.

## Testes adversariais exigidos pelo contrato

| Exigência do contrato | Teste |
| --- | --- |
| request exato é idempotente; mesmo `request_id` com descritor alterado conflita | "o pedido exato é idempotente e o mesmo request_id com descritor diferente conflita" |
| outro usuário, sessão, organização ou inquilino não enxerga, confirma, nega nem consome | "outro usuário, sessão, organização ou inquilino recebe o mesmo \"não existe\"" |
| POST sem CSRF falha | "CSRF ausente aborta antes de qualquer efeito" |
| cliente não escolhe autoridade e não existe `POST create` público | "não existe rota pública para CRIAR uma confirmação" + "POST exige CSRF e o cliente não escolhe nível, ação, sujeito nem \"aprovado\"" |
| T3 sem passkey recente falha; com passkey da mesma sessão passa | "T3 sem passkey recente falha fechado e NÃO consome o pedido" |
| expiração efetiva antes e depois da confirmação | "expira antes e depois da confirmação, e expirar é terminal" |
| negar não pode ser revertido; consumido não pode ser negado | "negar não se desfaz e consumido não pode ser negado" |
| `consume` exato após recriar serviço/repositório devolve o mesmo recibo | "o consumo exato é idempotente e sobrevive a recriar serviço e repositório-cliente" |
| outro `claim_id`, fingerprint, ação, sujeito ou nível falha fechado | "claim, fingerprint, ação, sujeito ou nível divergente falha fechado" |
| duas confirmações/consumos concorrentes não criam dois recibos | "duas confirmações e dois consumos concorrentes não criam dois recibos" + os testes de corrida encenada |
| exceção do storage permanece exceção | "exceção do armazenamento permanece exceção, nunca vira aprovação nem negação" |
| adapter mapeia `releaseId -> claimId`, sanitiza e preserva escopo/ação/sujeito/fingerprint | "mapeia releaseId para claimId, sanitiza o recibo e preserva escopo, ação, sujeito e fingerprint" |
| mensagens HTTP não vazam stack, caminho, segredo nem fingerprint | "a leitura pública não devolve o fingerprint" + "cada recusa do serviço tem um código HTTP próprio" |

Além do exigido: o modelo recusa **onze** formas de registro corrompido em vez
de deixá-las virar aprovação, e um id inexistente produz **exatamente a mesma
mensagem e o mesmo código** que um id de outra pessoa — nada na resposta revela
que a confirmação existe para outro inquilino.

## Uma coisa que foi removida em vez de coberta

O `consume` tinha uma checagem de expiração própria. Ela era **código morto**:
`#owned` já expira o que estava vencido antes de o fluxo chegar ali. Código
morto num caminho de segurança é onde um erro se esconde — foi removido, com o
motivo escrito no lugar.

## Achado pré-existente corrigido de passagem

`plugins/identity/src/http.ts` tinha duas guardas defensivas sobre
`createSessionGeneration()` cujo braço de falha é inalcançável. Elas faziam o
limiar obrigatório de **100% para `plugins/identity/src/**`** falhar em
99,74%/99,58% — ou seja, **a base M89, como entregue, não passava no próprio
limiar de cobertura**. As guardas foram mantidas (elas falham fechado se a
invariante mudar) e anotadas com a justificativa.

## Gates executados

Clone limpo, container Linux, Harness no pin, submódulo sem diff:

- `UPSTREAM_PIN=PASS commit=6c705be1… tree=a712eec5… manifest_sha256=862b9278…`
- `tsc --noEmit` **PASS**; `pnpm build` **PASS**
- `plugins/action-approval` + `plugins/staging`: **55 testes PASS**
- suíte raiz: **2095 aprovados**, 60 pulados, 3 reprovados
- coverage: statements 95,99% · branches 93,40% · functions 96,63% ·
  lines 98,06% — **zero violação de limiar**, incluindo o novo 100% obrigatório
  de `plugins/action-approval/src/{model,repository,service,http}.ts`
- `I18N_GATE=PASS` (14 catálogos, 290 chaves)
- `DOMAIN_ROUTE_GATE=PASS domains=26 files=2` (inclui `studio_action_approvals`)
- domain-scopes **PASS**; `PORTABILITY=PASS findings=0`

As 3 reprovações são as guardas de permissão POSIX do `builder-supervisor`
derrotadas pelo uid 0 do container; como usuário sem privilégio passam 103/103.

## O que continua em aberto

`NOT_EXECUTED`: PostgreSQL real. A durabilidade foi provada contra a
implementação em memória, que valida o mesmo modelo — mas *durável de verdade*
só depois de `test:postgres` com uma base real. Até lá, **BETA**.
`NOT_IMPLEMENTED`: montagem em perfil e emissão de pedidos por um serviço
consumidor real. Esta fatia entrega a autoridade, não o consumidor.
`NOT_EXECUTED`: `pnpm-lock.release.yaml` continua defasado (achado do Codex,
anterior a esta fatia): **a imagem de release ainda não contém M90**.
