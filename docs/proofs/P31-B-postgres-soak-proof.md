# P31-B — Prova de operação prolongada em PostgreSQL

- Resultado: **GO**
- Duração: 1 min; escritas: 139; erros: 0; leituras divergentes: 0.
- Latência de escrita+leitura (ms): p50 1.76, p95 4.74, máx 12.71.
- Memória do processo Studio (RSS MB): início 344.9, fim 298.3; heap 132.6 → 116.4.
- Backups a quente durante a carga: 4 criados, 0 falhas, 4 arquivos retidos, 4 linhas no ledger; o mais recente valida (formato + SHA-256) com 20 domínios e 122 registros.
- Escritor único: o segundo processo foi recusado 29 vezes durante toda a operação; após `SIGKILL` do Studio assumiu em 546 ms e leu 139 registros.
- Unidades no esquema: 20; registros de `studio_hello` ao final: 139.
- Ambiente: Studio real (profile `studio` + `postgres-proof.patch.yml`), PostgreSQL 16 local, sem Docker.

Não é prova de carga multiusuário nem de rede; é a operação contínua de um Studio sobre PostgreSQL com backup agendado e exclusão de escritor concorrente.
