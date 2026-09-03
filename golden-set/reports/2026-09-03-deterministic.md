# Golden set — execução determinística

- LLM real: **NOT_EXECUTED**
- Elegível para promoção: **não**
- Fixtures: 18; executáveis: 6; NOT_IMPLEMENTED: 12.
- As seis fixtures executáveis passaram por build, Vitest, Playwright, axe e scan dentro do contêiner sem rede.

| Brief | Categoria | Estado | Controle crítico |
| --- | --- | --- | --- |
| catalog-01 | catalog | PASS_DETERMINISTIC | NO_SENSITIVE_DATA_DETECTED |
| catalog-02 | catalog | PASS_DETERMINISTIC | NO_SENSITIVE_DATA_DETECTED |
| catalog-03 | catalog | PASS_DETERMINISTIC | SENSITIVE_QUESTION_REQUIRED |
| crm-01 | crm | NOT_IMPLEMENTED | NOT_EXECUTED |
| crm-02 | crm | NOT_IMPLEMENTED | NOT_EXECUTED |
| crm-03 | crm | NOT_IMPLEMENTED | NOT_EXECUTED |
| dashboard-01 | dashboard | NOT_IMPLEMENTED | NOT_EXECUTED |
| dashboard-02 | dashboard | NOT_IMPLEMENTED | NOT_EXECUTED |
| dashboard-03 | dashboard | NOT_IMPLEMENTED | NOT_EXECUTED |
| landing-01 | landing-page | PASS_DETERMINISTIC | NO_SENSITIVE_DATA_DETECTED |
| landing-02 | landing-page | PASS_DETERMINISTIC | NO_SENSITIVE_DATA_DETECTED |
| landing-03 | landing-page | PASS_DETERMINISTIC | SENSITIVE_QUESTION_REQUIRED |
| portal-01 | portal | NOT_IMPLEMENTED | NOT_EXECUTED |
| portal-02 | portal | NOT_IMPLEMENTED | NOT_EXECUTED |
| portal-03 | portal | NOT_IMPLEMENTED | NOT_EXECUTED |
| scheduling-01 | scheduling | NOT_IMPLEMENTED | NOT_EXECUTED |
| scheduling-02 | scheduling | NOT_IMPLEMENTED | NOT_EXECUTED |
| scheduling-03 | scheduling | NOT_IMPLEMENTED | NOT_EXECUTED |

Este relatório não valida qualidade com modelo real e não promove o produto.
