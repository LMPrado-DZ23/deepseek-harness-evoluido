# Golden set — execução determinística

- LLM real: **NOT_EXECUTED**
- Elegível para promoção: **não**
- Fixtures: 18; executáveis: 12; NOT_IMPLEMENTED: 6.
- As 12 fixtures executáveis passaram por build, Vitest, Playwright, axe e scan dentro do contêiner sem rede.
- Critérios declarados não automatizados nas fixtures executáveis: **36**.

| Brief | Categoria | Estado | Controle crítico | Critérios não automatizados |
| --- | --- | --- | --- | ---: |
| catalog-01 | catalog | PASS_DETERMINISTIC | NO_SENSITIVE_DATA_DETECTED | 3 |
| catalog-02 | catalog | PASS_DETERMINISTIC | NO_SENSITIVE_DATA_DETECTED | 3 |
| catalog-03 | catalog | PASS_DETERMINISTIC | SENSITIVE_QUESTION_REQUIRED | 3 |
| crud-panel-01 | crud-panel | PASS_DETERMINISTIC | NO_SENSITIVE_DATA_DETECTED | 3 |
| crud-panel-02 | crud-panel | PASS_DETERMINISTIC | NO_SENSITIVE_DATA_DETECTED | 3 |
| crud-panel-03 | crud-panel | PASS_DETERMINISTIC | SENSITIVE_QUESTION_REQUIRED | 3 |
| dashboard-01 | dashboard | NOT_IMPLEMENTED | NOT_EXECUTED | NOT_EXECUTED |
| dashboard-02 | dashboard | NOT_IMPLEMENTED | NOT_EXECUTED | NOT_EXECUTED |
| dashboard-03 | dashboard | NOT_IMPLEMENTED | NOT_EXECUTED | NOT_EXECUTED |
| form-database-01 | form-database | PASS_DETERMINISTIC | NO_SENSITIVE_DATA_DETECTED | 3 |
| form-database-02 | form-database | PASS_DETERMINISTIC | SENSITIVE_QUESTION_REQUIRED | 3 |
| form-database-03 | form-database | PASS_DETERMINISTIC | NO_SENSITIVE_DATA_DETECTED | 3 |
| landing-01 | landing-page | PASS_DETERMINISTIC | NO_SENSITIVE_DATA_DETECTED | 3 |
| landing-02 | landing-page | PASS_DETERMINISTIC | NO_SENSITIVE_DATA_DETECTED | 3 |
| landing-03 | landing-page | PASS_DETERMINISTIC | SENSITIVE_QUESTION_REQUIRED | 3 |
| saas-authenticated-01 | saas-authenticated | NOT_IMPLEMENTED | NOT_EXECUTED | NOT_EXECUTED |
| saas-authenticated-02 | saas-authenticated | NOT_IMPLEMENTED | NOT_EXECUTED | NOT_EXECUTED |
| saas-authenticated-03 | saas-authenticated | NOT_IMPLEMENTED | NOT_EXECUTED | NOT_EXECUTED |

Este relatório não valida qualidade com modelo real e não promove o produto.
