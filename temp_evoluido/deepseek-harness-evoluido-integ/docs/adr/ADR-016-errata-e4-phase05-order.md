# ADR-016 / Errata E4 — usabilidade depois do produto completo

- Estado: Aceita
- Data: 2026-09-03
- Decisor: Prado

## Contexto

O plano colocava cinco sessões com pessoas leigas antes de P32/P33/P31-B. O
responsável pelo produto decidiu testar o fluxo integrado, pois uma experiência
parcial não representa o sistema que será usado.

## Decisão

P32, P33 e P31-B podem ser construídos agora. A fase 0.5 ocorre depois do gate
Windows da fase 9 e antes do piloto da fase 10, usando o DZ23 STUDIO completo.
O kit `cdd2edb`, o protocolo, cinco sessões `VALID`, gate 4/5 e a decisão
`GO / ITERATE / NO_GO` são preservados; lançador e preflight serão adaptados ao
novo alvo nessa ocasião.

Até o `GO`:

- experiência para pessoas leigas é `NOT_VALIDATED`;
- piloto e release público são bloqueados;
- preview, staging, mock ou teste focado não podem ser chamados de aplicação
  pronta.

Durante a construção, linguagem pt-BR, ordem das etapas e glossário ficam em
arquivos separados e versionados. O fluxo do OmniSeek P40 é somente referência
inicial, sem incorporação de código. Deploy de produção permanece proibido.

## Pesquisa e retenção

Não há gravação por padrão. Quando houver consentimento específico, a gravação
é apagada em até 30 dias; somente resultados anônimos podem ser conservados.

## Consequência

Problemas de linguagem podem ser encontrados mais tarde e custar mais para
corrigir. O desacoplamento dos textos e a revisão de linguagem do Claude em cada
fatia reduzem esse risco sem fingir validação antecipada.
