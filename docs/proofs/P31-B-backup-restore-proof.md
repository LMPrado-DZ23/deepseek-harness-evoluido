# P31-B — Prova de restauração a partir da cópia de segurança (PostgreSQL)

- Resultado: **GO** (2026-09-04, ambiente do Claude, PostgreSQL 16 real, Studio real no profile `studio` com `postgres-proof.patch.yml`)
- Studio em PostgreSQL com cópia agendada ligada, populado pelos serviços reais (código de acesso, espaço de trabalho, projeto, pergunta e especificação).
- Duas cópias produzidas com o Studio **ligado**: a agendada (mesmo caminho do temporizador, `studio-backup-dz23_storage_rst_b5a03fde-20260904T030408414Z-5492b2.json`) e a do operador pela CLI `storage:backup-postgres` (`studio-backup-dz23_storage_rst_b5a03fde-20260904T030409108Z-e7a736.json`); ambas com `.sha256` conferido e formato `dz23-studio-kv-export/v1` validado; livro-razão `backups.jsonl` presente.
- Desastre simulado: `DROP SCHEMA … CASCADE`. Restauração pela CLI `storage:import-postgres` a partir da cópia agendada → 21 unidades, contagem igual à de antes.
- Studio religado sobre o esquema restaurado: a **mesma sessão** entra, projeto/especificação/espaços idênticos (JSON canônico), uma escrita nova cai no PostgreSQL e a cópia agendada volta a funcionar.
- Honestidade do ponto no tempo: a escrita feita **depois** das cópias não existe após a restauração — a prova afirma isso em vez de esconder.
- Segurança: a CLI **recusa** sobrescrever um esquema que já tem unidades sem `--force --confirm REPLACE_DZ23_STORAGE`, e os dados ficam intactos.

Não executado: restauração em servidor remoto com TLS `verify-full` (aqui `ssl off` local), Docker/Compose (ambiente do Claude sem daemon), restauração a partir de `pg_dump` (o caminho oficial é o bundle JSON; o dump é só rede de segurança do `--backup`).
