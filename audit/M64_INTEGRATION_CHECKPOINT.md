# M6.4 — Checkpoint de integração Windows

- data: `2026-09-06T05:41:00-03:00`
- branch candidata: `codex/m64-integration-candidate`
- base funcional: `c122c8a8df120844868df9cdb6cf603cd46fd5af`
- principal preservada: `codex/p30-policy-foundation@17e79aaab4c1ac54c1b4fc05f780f6485c5941b7`
- classificação: `REVIEW_REQUIRED`

## Composição

1. `d87a062` integra o preflight Windows somente leitura;
2. `a9bde84` integra a criação segura dos segredos do primeiro acesso.

As duas fatias foram reaplicadas sobre a ponta cumulativa M6.3b sem conflito. Nenhum merge ocorreu na principal.

O deploy legado herdado de `8059590` foi revogado depois que um store novo provou re-resolução fora do lock. A candidata passa a incluir a topologia dual documentada em `audit/M63_INSTALL_TOPOLOGY.md`: desenvolvimento com tipos canônicos e release moderno, congelado e offline.

## Evidência executada no Windows 11 com WSL2

| Gate | Resultado |
| --- | --- |
| preflight hermético/adversarial | `PASS`, 18 cenários |
| primeiro acesso e segredos | `PASS`, 12 testes |
| parser PowerShell exercitado pelas suítes | `PASS` |
| portabilidade Git + filesystem | `PASS` |
| self-test negativo de portabilidade | `PASS` |
| `git diff --check` das duas fatias | `PASS` |
| topologia de desenvolvimento + release | `PASS`, lock moderno offline |
| typecheck agregado e build | `PASS` no WSL2/ext4 |
| suíte integral com um worker | `1.896 passed`, `61 skipped`, `0 failed` |
| deploy portátil materializado | `PASS`, 533 pacotes e arquivos críticos presentes |

O preflight real da máquina não foi promovido a passe: Docker continua desligado, a porta 8080 estava ocupada por `wslrelay` na auditoria anterior e o pin da fonte ainda não está configurado. SMTP, domínio, certificado, firewall, Tailscale e envio real também continuam sem execução.

## Limites

- os testes provam validação, isolamento de segredos, permissões, escrita atômica, concorrência e fail-closed; não provam uma instalação Docker completa;
- STARTTLS continua recusado nesta fatia; somente TLS implícito é aceito enquanto o consumidor não expõe `requireTLS`;
- encerramento abrupto pode deixar o lock fail-closed; a recuperação guiada pertence ao lifecycle completo;
- M6.3b ainda aguarda revisão independente, portanto esta candidata também não pode ser mesclada.

## Próxima decisão técnica

Após a revisão independente de M6.3b e deste encaixe, a próxima prova é o preflight somente leitura na máquina real. A construção e execução de imagens só podem voltar quando o Docker for autorizado e houver espaço seguro; até lá permanecem `NOT_EXECUTED`.
