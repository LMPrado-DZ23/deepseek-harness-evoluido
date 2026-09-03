# ADR-002 / Errata E2 — OmniRoute externo e opcional

- Status: Aceito
- Data: 2026-09-02
- Escopo: Harness Studio v1.0 e fase 0.5
- Evidência: `docs/pocs/POC-03-omniroute-3.8.51.md`

## Contexto

O PoC-03 provou que o OmniRoute 3.8.51 pode iniciar em contêiner sem privilégios, sem `NET_ADMIN`, sem bind mounts e sem tocar o trust store do host. Também provou que o release fixado não consegue criar uma conexão de provedor pelo contrato suportado porque o artefato não encontra `tiktoken_bg.wasm`.

O OmniRoute é uma conveniência de roteamento e custo. Ele não é um componente arquitetural necessário ao núcleo do Studio.

## Decisão

1. O OmniRoute não é dependência nem pré-requisito da v1.0.
2. A v1.0 usa DeepSeek direto e adapters do `llm-pi-ai` para OpenRouter e Ollama.
3. A integração OmniRoute permanece disponível somente como rota externa opcional para usuário avançado, atrás de chave liga/desliga e desligada por padrão.
4. O Studio nunca instala, empacota, inicia ou administra OmniRoute, Agent Bridge, MITM, TPROXY, CA, DNS/hosts ou proxy do sistema.
5. O Studio consome apenas um endpoint `/v1` declarado pelo usuário, em loopback ou rede explicitamente autorizada.
6. OmniRoute e 9Router não podem ser ativados simultaneamente.
7. O perfil `Privado local` nunca usa OmniRoute com fallback para provedores externos. Ele aceita somente endpoint local declarado, Ollama ou rota direta compatível com a política.
8. O adapter do Studio tem retry igual a zero quando um gateway externo possui retry/cascade próprio.
9. O Studio não afirma suporte funcional a streaming, tools, uso ou tier cap do OmniRoute até uma prova futura completar esses contratos.

## Gate da fase 0.5

> Histórico: esta ordem foi substituída pela E4 em 03/09/2026. A fase 0.5 agora
> ocorre depois da fase 9 e antes do piloto; P32/P33/P31-B não dependem dela.

A dependência da fase 0.5 é corrigida para:

```text
fase 0 concluída + PoC-01b GO
```

O PoC-03 deixa de bloquear testes com pessoas leigas. A fase 0.5 está tecnicamente liberada.

## Condição de reavaliação

Uma versão futura só sobe de categoria se houver:

- imagem oficial de tag exata ou build reproduzível do snapshot fixado;
- runtime não privilegiado e sem montagem do host;
- trust stores e configuração do host idênticos antes/depois;
- criação, teste e uso de conexão pelo contrato oficial;
- streaming, tool calling e `usage` comprovados;
- falha injetada e autoridade única de retry comprovadas;
- limite de tier configurável e perfil privado sem fallback externo.

## Consequências

O cronograma não fica preso a um gateway externo instável. O seam `/v1` continua válido, e o OmniRoute pode ser reavaliado sem refatorar o núcleo quando cumprir o gate. A decisão reduz conveniência inicial, mas não reduz a capacidade essencial da v1.0.
