# Constituição do produto — DZ23 STUDIO

O que está aqui não se decide de novo a cada fatia. Uma linha só sai daqui por
decisão explícita do Prado, registrada em ADR.

## 1. Identidade

1. O nome público é **DZ23 STUDIO**. "DeepSeek Harness Studio" é histórico.
2. O logo oficial é o versionado; o original nunca é sobrescrito (ADR-003).
3. O produto é **open source e sem cobrança**: nada de assinatura, plano pago,
   crédito vendido, paywall, comissão, Stripe, checkout ou tela de upgrade
   (ADR-009).
4. Provedor externo pago entra **somente por BYOK** contratado pela própria
   pessoa. Ollama e local-first são opção de primeira classe.
5. A licença OSI ainda é **decisão do Prado**. Enquanto não houver decisão, o
   artefato **não é chamado de redistribuível**.

## 2. Autoridades únicas

Nenhuma segunda autoridade é criada para nada desta lista.

| domínio | autoridade única |
| --- | --- |
| orquestração e sessões | DeepSeek Harness |
| modelos | `ctx.llm` |
| agentes | seam de subagente/ACP do Harness |
| jobs | `ctx.jobs` |
| sandbox e execução | `ctx.sandbox`, `ctx.fs`, subprocessos e worktrees do Harness |
| identidade | trust plane do Studio, sessão opaca e revogável |
| organização, tenant, RBAC/ABAC | tenancy + policy do Studio |
| aprovações T0–T3 | `action-approval` |
| dados de sessão | journal append-only do Harness |
| dados de produto | `ctx.storage` |
| segredos | `ctx.credentials` e cofres do SO |
| integrações | Integration Hub sobre MCP/skills |
| preview, staging e deploy | portas próprias do Studio |
| auditoria | ledger append-only |

## 3. O Harness

O DeepSeek Harness é o **núcleo e único orquestrador**, fixado em
`6c705be1ce6774a000d061da41d1823b03a3d42c`.

**Diff zero.** Toda melhoria do Studio entra por plugin, perfil, adapter ou seam
público. Precisar mudar o Harness vira issue ou PR upstream — nunca fork
silencioso. O portão `gate:upstream-pin` reprova qualquer desvio.

## 4. Proibições

Estas não têm exceção sem decisão escrita do Prado.

1. Nunca instalar CA raiz, interceptar TLS, alterar `hosts`, ocupar 443 para
   interceptação, configurar TPROXY/MITM, DNS ou proxy do sistema.
2. 9Router e OmniRoute **nunca** ativos ao mesmo tempo. OmniRoute é externo,
   opcional, desligado por padrão e consome apenas `/v1`.
3. Compressão Caveman/RTK desligada por padrão; nunca transforma código, log ou
   erro sem opt-in explícito com preservação do original.
4. Nenhum componente BSL entra no artefato público.
5. Nenhum código do Zed entra no produto — apenas princípios de desempenho.
6. Nenhuma dependência do Roo Code.
7. Nenhum marketplace público antes de assinatura, origem, permissões,
   isolamento, trust store e kill switch comprovados.
8. Nenhum deploy autônomo em produção.
9. Nenhum segredo em cliente, celular, prompt, log, trace, arquivo gerado ou
   pacote — somente referências resolvidas por cofre.
10. Nenhuma telemetria comercial.
11. Perfil "Privado local" nunca faz fallback silencioso para rota externa.
12. Uma única autoridade de retry. Fallback só antes do primeiro token e de
    qualquer efeito.
13. Nenhuma cópia de código de terceiros antes do inventário P37 daquele
    projeto.

## 5. Critérios de verdade

Estes definem quando uma frase pode ser escrita.

1. **Um portão que passa com zero itens é uma falha, não um portão.**
2. **Um guarda que não pode falhar não é um guarda; um teste que não pode falhar
   é uma mentira sobre cobertura.** Toda guarda de segurança nova precisa de uma
   mutação que prove que o teste falha sem ela.
3. Mock, fixture, preview, teste focado, build verde, HTTP 200, flag, ZIP ou
   README **nunca** são chamados de "pronto", "funciona" ou "publicado".
4. Estado ambiental vermelho não é mascarado: vira `NOT_EXECUTED` ou
   `BLOCKED_EXTERNAL` com a causa escrita.
5. Verde artificial é proibido: remover teste, ignorar teste, diminuir asserção,
   desabilitar verificação, engolir exceção, devolver sucesso falso, hardcode
   apresentado como solução, mock apresentado como integração, remover
   funcionalidade ou reduzir segurança.
6. O executor **não declara `COMPLETED`**. Ele declara `CANDIDATE_COMPLETED` e
   chama auditoria independente.
7. Toda recusa é explicada em português claro, para uma pessoa leiga.
8. O dado de uma pessoa nunca é perdido nem alterado em silêncio.

## 6. Preservação

Nunca apagar worktree, branch, bundle, backup, histórico ou `plugins/*/lib/**`
sem decisão explícita e checkpoint recuperável. Nunca fazer reset destrutivo.
Nunca fazer push, PR, deploy, publicação, limpeza de Docker ou instalação de CA
sem autorização específica.

## 7. O ledger manda

`docs/MASTER_REQUIREMENTS_LEDGER.md` é a fonte única de "o que falta". Todo
requisito aceito tem uma linha lá com estado verdadeiro, prova e bloqueio. Um
requisito que não cabe na v1.0 **não é apagado**: fica com versão-alvo v1.x ou
v2. O portão `gate:requirements-ledger` reprova o ledger que perder um requisito,
usar um estado inventado ou declarar um estado bom sem prova.
