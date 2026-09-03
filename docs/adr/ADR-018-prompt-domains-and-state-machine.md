# ADR-018 — Domínios tenant-aware e máquina de estados

Status: aceito para a fatia 1.

Os sete domínios físicos são `studio_projects`, `studio_app_specs`,
`studio_intake_turns`, `studio_plans`, `studio_runs`, `studio_evidence` e
`studio_approvals`. Todos carregam `org_id` e `tenant_id`, passam pelo catálogo
único `STUDIO_DOMAIN_SPECS` e usam SQLite no perfil pessoal ou PostgreSQL no
perfil de equipe.

A máquina auditada é DRAFT → SPEC_READY → PLAN_PROPOSED → PLAN_APPROVED →
GENERATING → BUILD_OK/BUILD_FAILED → TESTS_OK/TESTS_FAILED →
VERIFIED_PROTOTYPE. Não existem READY, DONE, PUBLISHED ou DEPLOYED. Cada
transição e cada aprovação é gravada com ator, horário e escopo. Rotas derivam o
escopo da sessão e membership; valores enviados pelo cliente são rejeitados.
