# EB-04 — adaptador Ollama: prompt pronto para o executor

> **Por que este arquivo existe.** O EB-04 diz que não há provedor de LLM real
> neste ambiente, e por isso `real_llm`, `build` e `declared_criteria_passed` do
> golden set (P-07) estão `NOT_EXECUTED` desde sempre. O Ollama na máquina do
> Prado resolve isso — mas **não daqui**: o shell que roda naquela máquina está
> quebrado desde a atualização do Windows de 8 de setembro
> (`sandbox-helper: no Plan9 drive shares mounted`), e o contêiner de nuvem não
> alcança o `localhost` dele. Então o entregável é este: o prompt, com escopo,
> "NÃO FAZER" e comandos de verificação, para o executor rodar **no PC dele**.

## O que já existe, e não deve ser reimplementado

- A rota `ollama` **já está no catálogo**: `plugins/hello/src/index.ts:65`
  registra `routes: ['ollama', 'omniroute', 'deepseek-official']`.
- O contrato do modelo já existe: `PromptModelPort` e `HarnessPromptModel` em
  `plugins/prompt-to-app/src/ports.ts`. **Ninguém precisa mexer neles.**
- O perfil `privado-local` (`plugins/route-health/src/service.ts:17`) já garante
  que a requisição **não cai** para rota externa quando a local falha.
- `StudioFakeAdapter` (`plugins/hello/src/index.ts:106`) é PoC determinística e
  **não entra na imagem**. Ela não deve ser apagada nem substituída: os testes
  de runtime dependem dela.

O que falta é **um adaptador real** registrado para o provedor `ollama`.

## Prompt para o executor (Claude Code / Codex)

```
Repositório: C:\Users\zodyp\deepseek-harness-evoluido  (branch `integ`)

OBJETIVO
Escrever um adaptador de LLM real para o Ollama local e registrá-lo no provedor
`ollama`, de modo que o Studio consiga gerar um aplicativo de verdade sem
nenhuma credencial externa.

ARQUIVOS QUE VOCÊ PODE CRIAR OU ALTERAR
- plugins/hello/src/ollama-adapter.ts        (NOVO — o adaptador)
- plugins/hello/src/index.ts                 (SÓ para registrar o adaptador)
- plugins/hello/tests/ollama-adapter.spec.ts (NOVO — os testes)
- docs/MASTER_REQUIREMENTS_LEDGER.md         (uma linha nova, ao final)
- docs/status/EXTERNAL_BLOCKERS.md           (atualizar EB-04)

CONTRATO
`LlmAdapter` está em
third_party/deepseek-harness/packages/llm/llm/src/index.ts:193.
Implemente três métodos:
  - listModels(provider)   -> os modelos que `GET /api/tags` devolve
  - resolveModel(provider, model)
  - stream(options)        -> AsyncIterable<StreamChunk>

`stream` deve falar com `POST http://127.0.0.1:11434/api/chat` com
`{"stream": true}` e traduzir cada linha NDJSON em `StreamChunk` de texto.
Use `StudioFakeAdapter` (plugins/hello/src/index.ts:106) como referência DE
FORMATO dos chunks — e só disso.

REGRAS INEGOCIÁVEIS
1. O endereço do Ollama vem de variável de ambiente
   (`DZ23_OLLAMA_URL`, padrão `http://127.0.0.1:11434`). NUNCA em código.
2. Só `127.0.0.1` e `localhost` são aceitos por padrão. Um endereço remoto
   exige uma variável separada e explícita — sem isso, o perfil
   `privado-local` viraria mentira.
3. Ollama fora do ar é ERRO PRÓPRIO com código nomeado, nunca resposta vazia
   e nunca queda silenciosa para outra rota. Uma resposta vazia apresentada
   como sucesso é pior que a falha.
4. Timeout obrigatório por requisição (use `AbortSignal.timeout`).
5. NÃO apague nem altere `StudioFakeAdapter`.
6. NÃO altere `plugins/prompt-to-app/src/ports.ts`.
7. NÃO altere nada em `third_party/deepseek-harness/` — zero diff no upstream,
   e há portão que prova (`pnpm gate:upstream-pin`).
8. NÃO faça push, PR nem release. Commit local e pare.
9. Texto que a pessoa lê vai para o catálogo pt-BR, nunca literal no código
   (`pnpm gate:i18n` reprova).

NÃO FAZER
- Não instalar CA raiz, não mexer em `hosts`, DNS, proxy ou porta 443.
- Não ligar 9Router e OmniRoute ao mesmo tempo.
- Não escrever segredo em log, trace, arquivo gerado ou pacote.
- Não declarar PRONTO nem READY. Nenhuma linha do livro mestre usa `funciona`.

FALSIFICAÇÃO (obrigatória, e é o que separa teste de teatro)
Para cada guarda que você escrever, QUEBRE-A e confirme que um teste reprova.
No mínimo três:
  a) aponte a URL para um endereço remoto  -> deve ser RECUSADO
  b) faça o Ollama responder 500           -> deve virar erro nomeado, não texto vazio
  c) remova o timeout                      -> o teste de travamento deve reprovar
Registre as três no corpo do commit.

VERIFICAÇÃO (rode tudo, e cole a saída no commit)
  pnpm typecheck
  pnpm -w test
  pnpm gate:i18n
  pnpm gate:upstream-pin
  pnpm gate:secrets
  pnpm gate:requirements-ledger
  ollama list                       # prove que o modelo existe na máquina
  # e então, com o Studio de pé:
  pnpm tsx scripts/run-golden-set.ts    # o número que interessa

CRITÉRIO DE PRONTO
- `pnpm -w test` sem falha, e os portões acima PASS.
- Uma geração real atravessa: brief -> plano -> código, com o Ollama local.
- `docs/status/EXTERNAL_BLOCKERS.md` atualizado dizendo o que o EB-04 ainda
  bloqueia DEPOIS disto (o golden set com build real continua dependendo do
  ingresso do construtor).
- Commit local com as três falsificações descritas. SEM push.
```

## O que isto NÃO resolve

Ter o Ollama respondendo destrava `real_llm` do P-07. **Não** destrava `build`
nem `declared_criteria_passed`: esses dependem do ingresso do construtor
(contêiner com rede para instalar dependências do aplicativo gerado), que é
outro problema e continua aberto.
