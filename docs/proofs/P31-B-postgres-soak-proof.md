# P31-B — Prova de operação prolongada em PostgreSQL

- Resultado: **GO**
- Duração: 4 min; escritas: 2491; erros: 0; leituras divergentes na memória: 0; conferências diretas no PostgreSQL (última chave + contagem): 23, divergentes: 0.
- Latência de escrita+leitura (ms): p50 1.78, p95 3.12, máx 43.91.
- Memória do processo Studio (RSS MB): início 343.3, fim 315.3; heap 128.6 → 119.2.
- Backups a quente durante a carga: 8 disparados pelo worker (a cada 30 s) e 1 pelo agendador do próprio plugin (1 no arranque + 1 a cada 5 min), 0 falhas, 6 arquivos retidos, 9 linhas no ledger; o mais recente valida (formato + SHA-256) com 20 domínios e 2003 registros.
- Escritor único: o segundo processo tentou abrir a unidade a cada 2 s e foi recusado 119 vezes (zero erros de conexão); após `SIGKILL` do Studio assumiu em 614 ms e leu 2000 registros — exatamente os persistidos.
- Unidades no esquema: 20; registros de `studio_hello` ao final: 2000.
- Ambiente: Studio real (profile `studio` + `postgres-proof.patch.yml`), PostgreSQL 16 local, sem Docker.

Não é prova de carga multiusuário nem de rede; é a operação contínua de um Studio sobre PostgreSQL com backup agendado e exclusão de escritor concorrente.
