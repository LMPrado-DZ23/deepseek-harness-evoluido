# Golden set — execução determinística

- LLM real: **NOT_EXECUTED**
- Elegível para promoção: **não**
- Fixtures: 18; executáveis: 8; NOT_IMPLEMENTED: 10.
- As 8 fixtures executáveis passaram por build, Vitest, Playwright, axe e scan dentro do contêiner sem rede.

| Brief | Categoria | Estado | Controle crítico |
| --- | --- | --- | --- |
| catalog-01 | catalog | PASS_DETERMINISTIC | NO_SENSITIVE_DATA_DETECTED |
| catalog-02 | catalog | PASS_DETERMINISTIC | NO_SENSITIVE_DATA_DETECTED |
| catalog-03 | catalog | PASS_DETERMINISTIC | SENSITIVE_QUESTION_REQUIRED |
| crud-panel-01 | crud-panel | NOT_IMPLEMENTED | NOT_EXECUTED |
| crud-panel-02 | crud-panel | NOT_IMPLEMENTED | NOT_EXECUTED |
| crud-panel-03 | crud-panel | NOT_IMPLEMENTED | NOT_EXECUTED |
| dashboard-01 | dashboard | NOT_IMPLEMENTED | NOT_EXECUTED |
| dashboard-02 | dashboard | NOT_IMPLEMENTED | NOT_EXECUTED |
| dashboard-03 | dashboard | NOT_IMPLEMENTED | NOT_EXECUTED |
| form-database-01 | form-database | PASS_DETERMINISTIC | NO_SENSITIVE_DATA_DETECTED |
| form-database-02 | form-database | NOT_IMPLEMENTED | NOT_EXECUTED |
| form-database-03 | form-database | PASS_DETERMINISTIC | NO_SENSITIVE_DATA_DETECTED |
| landing-01 | landing-page | PASS_DETERMINISTIC | NO_SENSITIVE_DATA_DETECTED |
| landing-02 | landing-page | PASS_DETERMINISTIC | NO_SENSITIVE_DATA_DETECTED |
| landing-03 | landing-page | PASS_DETERMINISTIC | SENSITIVE_QUESTION_REQUIRED |
| saas-authenticated-01 | saas-authenticated | NOT_IMPLEMENTED | NOT_EXECUTED |
| saas-authenticated-02 | saas-authenticated | NOT_IMPLEMENTED | NOT_EXECUTED |
| saas-authenticated-03 | saas-authenticated | NOT_IMPLEMENTED | NOT_EXECUTED |

Este relatório não valida qualidade com modelo real e não promove o produto.
