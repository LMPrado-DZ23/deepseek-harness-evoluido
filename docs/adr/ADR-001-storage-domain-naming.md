# ADR-001 — Identificadores físicos e nomes lógicos de domínios

- Status: Aceito
- Data: 2026-09-01
- Escopo: todos os domínios persistentes e serviços que os referenciam no Harness Studio

## Contexto

O seam `storage-domain` do DeepSeek Harness no commit `6c705be1ce6774a000d061da41d1823b03a3d42c` aceita nomes físicos somente quando correspondem à gramática:

```text
^[a-z][a-z0-9_]*$
```

O PoC-01 revelou que `studio.hello` é adequado como nome lógico, mas inválido como identificador físico. Essa restrição não estava registrada no Plano Mestre e se repetiria em novos domínios como projeto, execução, aprovação e deploy.

## Decisão

Todo domínio do Studio terá dois identificadores explícitos:

1. **Identificador físico:** `snake_case`, ASCII minúsculo, estável e compatível com `^[a-z][a-z0-9_]*$`. É usado pelo `storage-domain`, tabelas, migrações, chaves internas e contratos de persistência.
2. **Nome lógico:** namespace com pontos, estável e legível, usado na interface, logs, auditoria, telemetria e documentação.

Exemplos:

| Conceito | Identificador físico | Nome lógico |
|---|---|---|
| Hello do Studio | `studio_hello` | `studio.hello` |
| Projeto | `studio_project` | `studio.project` |
| Execução de agente | `studio_run` | `studio.run` |
| Aprovação | `studio_approval` | `studio.approval` |
| Deploy | `studio_deploy` | `studio.deploy` |

O mapeamento será declarado no código ou no catálogo de domínio. Ele não será inferido em runtime por substituição automática de caracteres, pois isso esconderia colisões e mudanças incompatíveis.

## Regras de evolução

- Identificadores físicos não contêm ponto, hífen, barra, espaço, letra maiúscula ou caractere fora de ASCII.
- Nomes lógicos não são enviados diretamente a `defineDomain`.
- Renomear identificador físico exige migração explícita e compatibilidade de leitura durante a transição.
- Cada par físico/lógico é único no catálogo do Studio.
- Logs e UI mostram o nome lógico; mensagens de diagnóstico podem incluir também o físico.
- Testes de contrato validam a gramática física, a unicidade do par e o mapeamento esperado.

## Consequências

A convenção elimina decisões repetidas por domínio e mantém a interface amigável sem violar o contrato do Harness. O custo é manter um mapeamento explícito, considerado desejável porque torna migrações e auditoria verificáveis.

## Evidência

O PoC-01 provou que `defineDomain({ name: 'studio.hello', ... })` é rejeitado e que `studio_hello` é aceito sem modificar o upstream. O teste permanece como contrato de compatibilidade do pin.
