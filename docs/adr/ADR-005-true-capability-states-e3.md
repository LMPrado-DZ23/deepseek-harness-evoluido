# ADR-005 / Errata E3 — Estados verdadeiros de capacidade

- Status: Aceito
- Data: 2026-09-02

## Decisão

O DZ23 STUDIO distingue explicitamente:

- `NOT_PRESENT`: componente ou capacidade não existe no artefato;
- `NOT_CONFIGURED`: existe, mas falta configuração necessária;
- `NOT_EXECUTED`: existe e pode estar configurado, mas não foi provado;
- `BLOCKED_EXTERNAL`: a prova depende de serviço, credencial, pessoa ou
  infraestrutura externa indisponível.

Esses estados complementam ESTÁVEL, BETA, EXPERIMENTAL, DESLIGADO e NÃO
SUPORTADO. Nenhum deles pode ser convertido em “pronto”, PASS ou funcionando
apenas por declaração em documento, fixture, mock ou matriz de requisitos.

## Origem

A errata nasceu da auditoria P42 do DZ23 Autonomous Factory: 946 requisitos
marcados como PASS não equivalem a 946 provas executáveis. A regra se aplica a
todo o DZ23 STUDIO, independentemente da origem da capacidade.
