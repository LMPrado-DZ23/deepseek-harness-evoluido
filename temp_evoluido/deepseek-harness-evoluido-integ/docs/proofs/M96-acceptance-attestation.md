# M96 — E-05: o caminho de sucesso voltou a existir

## O achado que este trabalho corrige

`pipeline.ts` lançava `ACCEPTANCE_ATTESTATION_UNAVAILABLE` **exatamente quando o
ciclo do construtor passava e não havia diagnóstico** — isto é, no caminho de
SUCESSO. O ramo `state = 'PASSED'` era inalcançável, e com ele iam embora
`VERIFIED_PROTOTYPE`, a prévia e o aviso à pessoa. Havia dois testes de unidade
afirmando o beco sem saída como comportamento esperado.

Falhar fechado sem atestação era a decisão certa. O que faltava era a resposta a
uma pergunta de desenho, registrada no ledger: **como a atestação de aceitação
atravessa `BuilderLifecycleFinished`?**

## A resposta

Um campo **opcional** em `BuilderLifecycleFinished`:

```ts
readonly attestation?: BuilderAttestationFacts   // image_digest, policy_sha256, scope_id
```

Ele carrega os fatos que **só a sessão do construtor conhece**. Quem o preenche
é o escopo já **resolvido** — o mesmo cujo `preflight` recusa a sessão quando o
supervisor responde outra imagem ou outra política. Não é uma cópia da
configuração pedida: é aquilo sob o que o artefato foi realmente construído.

**Opcional de propósito.** Uma sessão que não consegue declarar imagem e política
não pode produzir uma atestação de aprovação, e a execução continua bloqueada
exatamente como antes. Um valor padrão ali seria a mentira mais barata do
repositório: bastaria esquecer de preencher para o Studio afirmar uma política
que ninguém conferiu.

## Os quatro documentos

Derivados do que aconteceu, gravados em `evidence/`, resumidos no registro da
execução (o documento inteiro no armazenamento por chave-valor cresceria sem
teto):

| documento | pergunta que responde |
| --- | --- |
| `attestation-acceptance.json` | os critérios que a pessoa escreveu foram conferidos, um a um? |
| `attestation-manifest.json` | exatamente quais arquivos formam este artefato, e com que conteúdo? |
| `attestation-sbom.json` | de que ele é feito — quais dependências, em que versão? |
| `attestation-provenance.json` | quem construiu, a partir de quê, com que imagem e política? |

**O veredito de aprovação exige tudo ao mesmo tempo**: nenhum critério
reprovado, nenhum pendente, ciclo do construtor concluído e integridade do
template verificada. E **zero critérios reprova** — ausência de conferência não
é aprovação; sem essa linha, um relatório sem nenhum critério passaria com nota
máxima.

**A atestação manda sobre o "passou" do construtor.** Se o ciclo ficou verde e a
atestação reprovou, a execução falha. O veredito da atestação é o que a pessoa
vai mostrar a alguém.

## Provas

`plugins/prompt-to-app`: 28 testes de pipeline, 20 de atestação, 39 de ciclo de
vida. Suíte de prompt-to-app + preview + studio-web: **857 testes**.

**13 mutações, 13 mortas:**

| mutação | morta |
| --- | --- |
| critério reprovado não derruba o veredito | sim |
| critério pendente não derruba o veredito | sim |
| integridade do template ignorada | sim |
| ciclo do construtor ignorado | sim |
| zero critérios aprova | sim |
| SBOM sem `package.json` parece vazio legítimo | sim |
| versão não-texto vira componente | sim |
| resumo depende da ordem dos campos | sim |
| manifesto depende da ordem de leitura | sim |
| proveniência se cala sobre não ser assinada | sim |
| atestação ausente deixa de bloquear | sim |
| veredito reprovado vira sucesso | sim |
| construtor não declara imagem nem política | sim |

O teste que fecha a jornada faz o passo `test` **reescrever o relatório de
aceitação**, que é o que a suíte do app gerado realmente faz — e só então o
pipeline chega a `VERIFIED_PROTOTYPE`.

## O que os documentos NÃO dizem, e dizem que não dizem

- **Não são assinados.** `signed: false` e
  `HASH_NAO_E_ASSINATURA: integridade verificavel, origem nao provada` estão
  dentro do documento de proveniência. Hash dá integridade e rastreabilidade;
  não dá prova de origem contra quem possa reescrever o disco.
- **O SBOM lista o que o app DECLARA**, não a árvore instalada resolvida. Um
  `^1.2.3` não diz qual versão foi instalada, e `source: 'declared'` está no
  documento para que ninguém leia mais precisão do que existe.
- **`unavailable` não é "não depende de nada".** Sem `package.json` legível, a
  lista sai vazia com `unavailable_reason` escrito — porque uma lista vazia
  silenciosa seria lida como um app sem dependências.

## Limites que continuam em E-05

Não é retomável (cancelado ou interrompido recomeça do zero) e não há orçamento
por token na geração. Ambos declarados no ledger.
