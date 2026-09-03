# P31-B — Prova de operação prolongada em PostgreSQL

- Resultado: **GO**
- Duração: 2 min; escritas: 259; erros: 0; leituras divergentes na memória: 0; conferências diretas no PostgreSQL (última chave + contagem): 13, divergentes: 0.
- Latência de escrita+leitura (ms): p50 1.73, p95 2.97, máx 9.47.
- Memória do processo Studio (RSS MB): início 343.7, fim 303.5; heap 127.6 → 117.
- Backups a quente durante a carga: 4 disparados pelo worker (a cada 30 s) e 1 pelo agendador do próprio plugin (1 no arranque + 1 a cada 5 min), 0 falhas, 5 arquivos retidos, 5 linhas no ledger; o mais recente valida (formato + SHA-256) com 20 domínios e 242 registros.
- Escritor único: o segundo processo tentou abrir a unidade a cada 2 s e foi recusado 59 vezes (zero erros de conexão); após `SIGKILL` do Studio assumiu em 497 ms e leu 260 registros — exatamente os persistidos.
- Unidades no esquema: 20; registros de `studio_hello` ao final: 260.
- Ambiente: Studio real (profile `studio` + `postgres-proof.patch.yml`), PostgreSQL 16 local, sem Docker.

Não é prova de carga multiusuário nem de rede; é a operação contínua de um Studio sobre PostgreSQL com backup agendado e exclusão de escritor concorrente.
