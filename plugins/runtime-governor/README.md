# `@dz23-studio/runtime-governor`

Governador de capacidade fail-closed para trabalhos de geração, builds e previews do DZ23 STUDIO.

## Limites padrão

| Recurso | Global | Por tenant | Por projeto |
| --- | ---: | ---: | ---: |
| `prompt-job` | 4 | 2 | 1 |
| `build` | 1 | 1 | 1 |
| `preview` | 4 | 2 | 1 |

`acquireBundle` reserva todos os recursos pedidos de forma atômica: se um limite falhar, nada é reservado. Cada reserva recebe um token de fencing monotônico e expira em 120 segundos sem heartbeat. O TTL aceito fica entre 1 segundo e 1 hora.

`MemoryCapacityGovernor` é apropriado para um único processo. Uma implantação com múltiplas réplicas deve usar uma implementação distribuída do mesmo contrato, com transação e fencing persistente; não se deve compartilhar esta implementação em memória entre réplicas como se ela oferecesse coordenação distribuída.

`snapshot` e `reconcile` removem leases expirados antes de informar o estado. `release` e `heartbeat` exigem o token da geração atual, impedindo que um trabalhador antigo libere ou renove uma reserva posterior que reutilize o mesmo identificador.
