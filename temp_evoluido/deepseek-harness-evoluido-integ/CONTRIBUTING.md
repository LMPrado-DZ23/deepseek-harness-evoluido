# Como contribuir com o FRIGG

Obrigado pelo interesse. Este projeto tem um jeito de trabalhar bastante
específico, e ele existe por um motivo: **o risco maior deste código nunca foi o
código — foi a evidência que parecia cobrir e não cobria.** Quatro rodadas de
auditoria independente chegaram à mesma conclusão, e o que está escrito abaixo é
o que sobrou delas.

## A regra que vale mais que todas

> **Um portão que passa com zero itens é uma falha.**

Se você escreveu uma verificação e ela aprovou de primeira sem nunca ter
reprovado nada, ela provavelmente não está olhando para o que você acha que está.
Sabote o próprio código e confira que a verificação reprova. Quase todos os
`scripts/check-*.mjs` deste repositório têm um `--self-test` que faz exatamente
isso.

## Antes de abrir um *pull request*

```bash
pnpm gate:typecheck     # a raiz E apps/studio-web: são dois projetos de verdade
pnpm build
pnpm exec vitest run --maxWorkers=1
pnpm gate:i18n          # nenhum texto de pessoa solto no código
pnpm gate:secrets
pnpm gate:tracked-lib   # o lib/ versionado importa só o que o repositório tem
pnpm gate:lib-freshness # …e é o que `pnpm build` produz do src/ de hoje
pnpm gate:requirements-ledger
```

Se puder rodar tudo, `docs/OPERACAO.md` tem o laço dos **24 portões** e o
comando das quatro suítes — raiz, interface, navegador e PostgreSQL. A CI roda
os 24; rodar só os sete acima é o mínimo para não desperdiçar uma rodada.

Se você mexeu em domínio de dados, `pnpm gate:domain-scopes` e
`pnpm gate:rls-coverage`. Se mexeu na interface, `pnpm --dir apps/studio-web
exec playwright test` (precisa de `pnpm build` antes: o e2e roda contra `dist`).

O procedimento completo de árvore limpa está em
[`docs/BOOTSTRAP.md`](./docs/BOOTSTRAP.md).

## O que não passa na revisão

Estas coisas são recusadas independentemente de quão bem escritas estejam:

- **Verde artificial.** Remover teste, afrouxar asserção, desligar verificação,
  engolir exceção, `try/catch` vazio, mock apresentado como integração real.
- **Texto de pessoa fora do catálogo.** A interface é em português do Brasil e o
  texto vive em `i18n/`. O portão `gate:i18n` reprova literal com forma de frase
  em plugin que já mantém catálogo.
- **Jargão na tela.** `BUDGET_EXCEEDED` não é frase; "o limite de uso desta conta
  foi alcançado" é. Código de máquina, quando aparece, aparece **depois** da
  explicação, dentro de "Detalhes técnicos".
- **Alteração no `third_party/deepseek-harness`.** O submódulo é fixado e o
  produto compõe sobre as costuras públicas. Diferença ali reprova a integração.
- **Estado inventado no livro-razão.** `docs/MASTER_REQUIREMENTS_LEDGER.md` não
  usa "pronto" nem "funciona". Se a prova é sobre dado simulado, o estado é
  `NOT_EXECUTED` — não `BETA`.
- **Segredo em qualquer lugar.** Nem em teste, nem em *fixture*. `gate:secrets`
  varre inclusive `tests/`, e a isenção é **nominal**: arquivo, regra e motivo.

## Comentário de código

Comentário aqui não descreve o que a linha faz — isso a linha já diz. Ele explica
**por que** a linha é assim, de preferência contando o defeito que ela evita.
Compare:

```ts
// ruim: repete o código
// soma os tokens da tentativa
spent += tokens

// bom: diz o que estava errado antes
// Os tokens SOMADOS da operação, e não os da última tentativa. O gasto de uma
// criação é o das três somadas, e é isso que o teto olha.
spent += tokens
```

## Mensagem de *commit*

Assunto curto e concreto. No corpo: o defeito, a causa, a correção e a **prova**,
com os números da execução. Se você corrigiu algo que um teste não pegava, diga
que o teste não pegava.

## Idioma

Código, identificadores e nomes de arquivo em inglês. Comentários, documentação,
mensagens de *commit* e **todo texto que uma pessoa lê** em português do Brasil.

## Segurança

Vulnerabilidade **não** vai para *issue* pública. Veja [`SECURITY.md`](./SECURITY.md).
