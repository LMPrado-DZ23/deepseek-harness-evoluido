# M6.3 — Checkpoint de integração do builder e ingresso de artefatos

- data: `2026-09-06T04:13:16-03:00`
- branch candidata: `codex/m63-integration-candidate`
- base comum com a principal: `17e79aaab4c1ac54c1b4fc05f780f6485c5941b7`
- principal preservada: `codex/p30-policy-foundation@17e79aaab4c1ac54c1b4fc05f780f6485c5941b7`
- ponta antes deste checkpoint: `a96974742fd3d97268aeec1d8b5587877576f382`
- classificação: `REVIEW_REQUIRED`

## Composição integrada

Esta branch reúne, sem merge na principal:

1. `a01b54717aa64169dcdb3901e183549e03dac652` — registro durável de ativação do runtime;
2. `575ccc050f262d88215e99979b0d7fe665353de0` — lifecycle gerenciado do Prompt-to-App;
3. `f1e9d75a3e60d82013df5b8504b60c2f22344f9c` — capacidade e materialização do manager;
4. `a96974742fd3d97268aeec1d8b5587877576f382` — núcleo autenticado de ingresso de artefatos;
5. as correções de integração, rollback e segurança registradas neste checkpoint.

## Contrato resultante

- O Prompt-to-App cria um TAR canônico, calcula o SHA-256 dos bytes efetivamente transmitidos e envia o fluxo ao ingresso autenticado.
- O RPC de preparação recebe somente um `upload_ref` opaco. Caminho local, caminho relativo e hash declarado pelo cliente não fazem parte do contrato.
- O supervisor reivindica o upload vinculando-o ao `build_id`, escopo, imagem e política; o mesmo descritor validado chega ao adapter.
- O servidor Unix despacha `/v1/artifacts/*` antes de tentar acumular JSON e mantém resposta de erro limitada quando o ingresso não existe.
- A composição standalone e a composição gerenciada usam `ArtifactIngressStore`, executam a varredura inicial e publicam o endpoint de ingresso.
- O lifecycle descarta o TAR local antes da preparação remota e converte erros do ingresso em estados públicos limitados.

## Invariantes de segurança exercitados

- `O_NOFOLLOW` ao abrir o TAR local e rejeição de identificador de build inválido antes de criar staging;
- cancelamento do chamador classificado como `CANCELLED`, artefato inválido como `BUILD_FAILED` e erros internos sem detalhes privados;
- upload reivindicado sempre recebe `complete` ou `fail`, inclusive quando claim, journal, rollback ou settlement falham;
- falha dupla de rollback retorna `CLEANUP_INCOMPLETE` e não declara limpeza concluída;
- alteração concorrente e replay são recusados pelo estado durável do ingresso;
- nenhum caminho do computador da pessoa é enviado pelo protocolo do builder.

## Evidência executada

Ambiente de gate: WSL2/Ubuntu em ext4, diretório isolado `/home/leandro/dz23-gates/m63-integration-20260906`, dependências instaladas offline com lock fixado.

| Gate | Resultado |
| --- | --- |
| `builder-supervisor` com cobertura | `648 passed`, `26/26` arquivos, exit `0` |
| arquivos críticos de ingresso, serviço, manager e servidor Unix | `100%` statements/branches/functions/lines |
| suíte integral do Studio | `1.896 passed`, `61 skipped`, `0 failed`, exit `0` |
| build da interface e dos 14 plugins | `PASS`, exit `0` |
| portabilidade + self-test negativo | `PASS` |
| i18n | `PASS`, 9 catálogos, 287 chaves, baseline sem crescimento |
| escopos de domínio | `PASS` |
| rotas de domínio | `PASS`, 23 domínios em 2 patches |
| `git diff --check` | `PASS` |
| varredura do diff por formatos de chave privada e tokens conhecidos | `PASS` |
| gate de pin do upstream — self-test | `PASS`, 5 fixtures negativas |
| gitlink do Harness | `160000 6c705be1ce6774a000d061da41d1823b03a3d42c` |

Os 61 testes pulados são as suítes que exigem PostgreSQL externo; não foram contados como aprovação.

## Limitações e provas ainda ausentes

- `pnpm typecheck` agregado não está verde no staging: o modo `nodeLinker=hoisted` com pacotes de workspace injetados materializou identidades duplicadas de tipos com marca privada. Os builds TypeScript individuais dos 14 plugins passam. Isto é uma pendência real do gate agregado, não defeito ocultado como sucesso.
- O gate completo de pin não consegue validar URL de `origin` porque este repositório local não possui remoto. O self-test e o gitlink fixado passam.
- Docker permanece desligado. A construção/execução do builder real, inspeção de `NetworkMode`, isolamento de rede e fluxo contêiner-a-contêiner estão `NOT_EXECUTED`.
- PostgreSQL real não estava configurado neste staging; suas 61 integrações estão `NOT_EXECUTED` nesta rodada.
- Não houve teste de celular físico, cinco pessoas leigas, piloto, deploy, push ou release.
- A licença open source do DZ23 STUDIO ainda não foi escolhida; o projeto não pode ser chamado de redistribuível.

## Decisão deste checkpoint

O código integrado está apto a revisão independente como candidato local. Ele não deve ser mesclado na principal antes do parecer do Claude e do fechamento explícito do typecheck agregado. As provas físicas de Docker permanecem obrigatórias quando o daemon voltar a estar disponível.
