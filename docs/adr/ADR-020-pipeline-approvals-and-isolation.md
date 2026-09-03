# ADR-020 — Aprovações, tentativas e isolamento do pipeline

Status: aceito para a fatia 1.

Aprovar o plano e iniciar a geração offline são T1. Preparar dependências com
rede é T2. Segredos, rede externa e qualquer deploy são T3 com identidade forte
e não fazem parte desta fatia. O pipeline executa em contêiner descartável sem
rede, privilégios ou capacidades, com raiz somente leitura e uma única montagem
gravável para a execução.

São permitidas no máximo três tentativas. Falhas são distinguidas entre geração,
build e testes. `BLOCKED_EXTERNAL` encerra antes da geração quando o construtor
isolado não está disponível. Logs e relatórios são evidências com SHA-256. O
estado final desta fatia é somente `VERIFIED_PROTOTYPE`.
