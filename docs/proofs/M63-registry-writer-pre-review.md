# M6.3-A — Autoridade durável e ativação (checkpoint para revisão)

**Base:** `codex/m63-integration-candidate@a685301`
**Branch isolada:** `codex/m63-registry-writer`
**Estado:** `PRE_REVIEW`; sem commit, merge, push, PR, deploy ou Docker real.

## Contrato implementado

- O provisionador valida a representabilidade USTAR de todas as entradas antes
  de criar qualquer caminho do scope administrado.
- `template-store.manifest.json` é persistido em JSON canônico, modo `0600`, e
  referenciado exatamente pelo `supervisor.json` v2.
- O framing `dz23-builder-config-envelope-v2` cobre, por nome+tamanho+bytes,
  configuração, imagem, hash da árvore, manifesto canônico e política. O token
  permanece fora do digest. O vetor v1 existente não foi reinterpretado.
- O resultado de provisionamento devolve somente `scope_id`, referência e hash
  físicos da configuração; token e identidades lógicas não entram no registry.
- O registry continua schema v1. Seu writer gera a próxima geração no servidor,
  limita a 512 slots e publica por temporário `0600`, `fsync`, `rename` e
  `fsync` do diretório, sob um guard permanente próprio em ext4/XFS.
- Uma autoridade privada `pending/committed` antecede a troca do registry. Ela
  permite concluir uma queda antes/depois do rename sem aceitar rollback,
  instalação divergente ou conteúdo duplicado/corrompido.
- Repetir a mesma ativação não gira token, scope, config digest nem geração.
- Em reprovisionamento, a autoridade/configuração existente é autenticada sob o
  guard antes de acessar o template-store. Uma versão divergente falha com
  `TARGET_MISMATCH` sem materializar o novo diretório; a autoridade é relida
  depois da validação do store.
- O caminho de repetição somente exige e valida diretórios existentes. A
  ausência do parent `template-store` falha sem recriá-lo nem alterar qualquer
  outro caminho ou byte durável.
- O SHA do manifesto devolvido e persistido é sempre o SHA dos bytes canônicos,
  inclusive quando a fonte fixada tem ordem ou formatação JSON diferente.

## Evidência focada desta árvore

- `store-provision.spec.ts`: 52/52 PASS.
- `supervisor-config.spec.ts`: 14/14 PASS.
- `manager-registry.spec.ts`: 5/5 PASS.
- `manager-registry-writer.spec.ts`: 11/11 PASS.
- `runtime-activation.spec.ts`: 2/2 PASS.
- Coverage focada crítica de `manager-registry`, `manager-registry-writer`,
  `runtime-activation` e `supervisor-config`: 100% statements, branches,
  functions e lines em cada arquivo.
- Coverage focada de `store-provision`: 90,10% statements, 84,97% branches,
  98,07% functions e 97,18% lines; todos os pisos preservados.
- TypeScript `tsconfig.build.json --noEmit`: PASS.
- `git diff --check`: PASS.

Casos cobertos: vetores v1/v2, token fora do digest, manifesto independente da
formatação da fonte com um único SHA canônico, recusa de nova versão antes de
efeitos duráveis, permissões/hardlinks/tamanho/canonicidade/tree/version,
USTAR impossível antes de efeitos, quedas nos dois lados do rename, concorrência
sem lost update, idempotência, instalação divergente, rollback, duplicata,
registry cheio, geração exaurida, relações `pending/committed` divergentes,
temporários inseguros, falhas reais de flock e guard danificado.

## Limites honestos

- Docker real continua `NOT_EXECUTED` e não é necessário a esta fatia.
- A suíte completa não foi repetida depois das mutações de coverage; o último
  518/518 foi a execução independente anterior. Mutation runner não foi executado.
- A ativação só publica autoridade/registry; o manager fará materialização e
  lifecycle no wiring posterior, fora desta ownership.
