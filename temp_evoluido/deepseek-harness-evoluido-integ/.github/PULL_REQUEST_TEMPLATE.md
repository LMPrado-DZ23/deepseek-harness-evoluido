## O que muda, e por quê

<!-- O defeito ou a necessidade primeiro; a solução depois. -->

## Prova

<!-- Os números da execução, colados. Não "os testes passam". -->

```
pnpm typecheck  ->
pnpm build      ->
vitest run      ->
portões         ->
```

## Falsificação

<!--
Você sabotou o próprio código e conferiu que o teste reprova?
Cole a mutação e o resultado. Se não fez, diga por quê.
Um portão que passa com zero itens é uma falha.
-->

## Conferido

- [ ] `pnpm typecheck`, `pnpm build` e a suíte passam
- [ ] Texto que a pessoa lê está no catálogo `i18n/`, em português do Brasil
- [ ] Nenhum segredo, nem em teste nem em *fixture*
- [ ] `third_party/deepseek-harness` intocado
- [ ] Se um estado do livro-razão mudou, a linha foi atualizada com a prova
- [ ] Se mexi na interface: e2e e axe rodaram depois de `pnpm build`
