# Operação — como rodar e como provar

Os comandos, com os caminhos e as variáveis que de fato funcionam. Tudo aqui
foi executado; nada é sugestão.

Para **abrir o produto**, o caminho é [`COMECAR.md`](./COMECAR.md). Para
**instalar do zero com verificação**, é [`BOOTSTRAP.md`](./BOOTSTRAP.md). Este
arquivo é para quem vai **mexer no código**.

---

## Os portões

**Todos de uma vez**, que é como uma entrega termina:

```bash
pnpm gates
```

Ele descobre a lista no `package.json` — não há lista escrita à mão em lugar
nenhum —, roda cada portão, grava os vereditos e termina executando a
constituição sobre eles. Sai com `GATES_FAIL=0` e `CONSTITUTION=PASS` quando
está tudo certo, e com código 1 quando não está.

```bash
pnpm gates --listar              # diz o que rodaria, sem rodar nada
pnpm gates --apenas marca,pix    # só estes
pnpm gates --verdicts /caminho   # onde gravar os vereditos
```

Um de cada vez continua sendo `pnpm gate:<nome>`.

> **Por que não há uma lista aqui.** Até 18/09/2026 este arquivo trazia os nomes
> dos portões escritos à mão, e um laço de shell que os repetia. Eram vinte e
> quatro aqui, trinta num `/tmp/gates.sh` que cada sessão recriava, e trinta e um
> no `package.json` — `gate:licenses:release` existia e nenhuma sessão o
> executava. Três listas do mesmo fato, e a que estava certa não era a que se
> lia. `scripts/run-gates.mjs` lê a única que o `pnpm` obedece.

Ele acha a raiz do repositório sozinho, então funciona de qualquer diretório e
em qualquer máquina. Os vereditos e o registro de cada portão vão para o
temporário do sistema, e o caminho sai impresso na última linha.

---

## As suítes

```bash
# raiz — ~3 a 4 minutos
npx tsc -p tsconfig.json --noEmit
npx vitest run

# interface
cd apps/studio-web
npx tsc --noEmit
npx vitest run
npm run build        # obrigatório ANTES do e2e
```

### Ponta a ponta, em navegador de verdade

```bash
cd apps/studio-web
pnpm exec playwright install chromium   # a MESMA compilação que a CI instala
npx playwright test
```

**Não force outro Chromium.** `DZ23_CHROMIUM_PATH` continua existindo, mas a
configuração recusa um caminho cuja compilação não seja a fixada pelo
`@playwright/test` desta árvore — que é a que a CI instala. Rodar aqui um
navegador que a CI não roda foi exatamente o que produziu cinco entregas com
"verde" local e CI vermelha: Chromium 133 recusa o prefixo `__Host-` sobre
http e o 141 aceita, e o teste de cookie de sessão dependia disso.

Para MEDIR de propósito a diferença entre navegadores, declare junto
`DZ23_CHROMIUM_OUTRA_COMPILACAO=sim` — aí está dito em voz alta que o que se
está medindo é outra coisa.

São 121 testes em quatro tamanhos de tela.

### As capturas da entrega

A jornada capturada roda sempre; o que muda é ONDE o PNG cai. Só com a variável
abaixo ele vai para `apps/studio-web/capturas/`, que é versionado:

```bash
cd apps/studio-web
DZ23_CAPTURAS=sim npx playwright test --project=gravacao
```

Sem ela — o caso da CI —, a captura sai na pasta de resultados do Playwright.
Isso existe porque um PNG é diferente a cada execução, e o passo final da CI
("Refuse unexpected build mutations") reprova, com razão, quando a árvore muda
sozinha. Se um servidor de teste ficar
pendurado, mate-o com a forma em colchete — sem ela o `pkill` casa com o
próprio comando e mata a si mesmo:

```bash
pkill -9 -f 'tests/serve[r].ts'
```

### As duas imagens que NÃO saem de teste nenhum

O QR do PIX e o cartão social do repositório são gerados por roteiro, cada um a
partir da sua fonte, e ficam versionados. Rode-os quando a fonte mudar:

```bash
node scripts/build-pix-qr.mjs       # le docs/pix-payload.txt  -> docs/images/pix-qr.png
node scripts/build-social-card.mjs  # le marca.ts + theme.css  -> docs/images/social-card.png
```

Os dois precisam de um pacote do Python (`segno` e `pillow`). `gate:pix` confere
o payload; `gate:marca` confere que o cartão social foi gerado para a marca que
vale hoje — ele grava a procedência dentro do próprio PNG.

**O cartão social não se publica sozinho.** A imagem social do repositório não
existe na API do GitHub nem no `gh`: ela é enviada à mão, em
*Settings → General → Social preview*. O roteiro produz o arquivo; carregá-lo é
do titular.

### PostgreSQL real

Sem a variável, a suíte de PostgreSQL é **pulada** — e uma suíte pulada não é
uma suíte que passou:

```bash
# A senha NÃO fica escrita aqui. `gate:secrets` recusa uma DSN com senha em
# arquivo versionado — e recusou a primeira versão deste próprio documento.
# Um exemplo de teste hoje é o que alguém copia para produção amanhã.
export PGPASSWORD='<a senha do seu PostgreSQL de teste>'
DZ23_POSTGRES_TEST_DSN="postgresql://dz23:${PGPASSWORD}@127.0.0.1:55432/dz23_test" \
DZ23_OPERATOR_STATE_DIR=/tmp/dz23-operator-state \
pnpm -w test:postgres
```

Esperado: `POSTGRES_GATE=PASS server=preset-dsn mode=integration`, 65 testes.

---

## Números de referência

Da última varredura completa (`f2d7529`). Servem para reconhecer uma regressão,
e não como meta:

| | |
| --- | --- |
| portões | 21/21 `EXIT=0` |
| constituição | PASS, 33 vereditos |
| `tsc` | 0, na raiz e em `studio-web` |
| suíte da raiz | 3.518 passaram, 68 pulados |
| suíte da interface | 527 |
| ponta a ponta | 117, em quatro tamanhos |
| PostgreSQL 16 | 65/65 |

---

## Falsificação — o roteiro

O procedimento está em `CLAUDE.md`. Aqui está a forma do roteiro, que já pegou
dezenas de defeitos:

```bash
#!/bin/bash
cd /caminho/do/repo
F=plugins/x/src/arquivo.ts
SPEC=plugins/x/tests/arquivo.spec.ts
SURV=()

try() {
  local nome="$1"; shift
  git checkout -- "$F" 2>/dev/null
  "$@" || { echo "$nome: SED-FALHOU"; git checkout -- "$F"; return; }
  if npx vitest run $SPEC > /tmp/sab.log 2>&1
    then echo "$nome: SOBREVIVEU"; SURV+=("$nome")
    else echo "$nome: PEGOU"; fi
  git checkout -- "$F" 2>/dev/null
}

try "descreva o defeito que esta sabotagem introduz" \
  perl -0pi -e "s/linha original/linha sabotada/" "$F"

echo "SOBREVIVENTES: ${SURV[*]:-nenhuma}"
git checkout -- "$F" 2>/dev/null
```

**Rode `git add -A` antes.** O `git checkout --` restaura do índice: sem isso
você perde o trabalho que ainda não indexou. Aconteceu duas vezes.

Duas armadilhas de quem escreve sabotagem:

- **`perl -0pi -e` devolve 0 mesmo sem casar nada.** Uma sabotagem que não
  alterou o arquivo aparece como `SOBREVIVEU` e parece um buraco. Confira se o
  padrão realmente bateu antes de acreditar num sobrevivente.
- **Uma sabotagem sem efeito observável não é buraco.** Ordenação estável, saída
  antecipada por custo, guarda de defesa em profundidade: essas sobrevivem por
  natureza. O destino delas é ser **declarada**, não fingida.

---

## Ambiente, e o que ele impõe

- **`pnpm`, nunca `npm install`.** `packageManager` fixa a versão.
- **Node `22.23.1`**, fixado em `.nvmrc`. Maior diferente quebra; menor
  diferente o doctor apenas informa.
- Uma chamada de terminal com **limite de 2 minutos** não aguenta a suíte da
  raiz. Rode em segundo plano e leia o arquivo depois:
  ```bash
  setsid nohup bash -c 'npx vitest run > /tmp/r.log 2>&1; echo "RC=$?" >> /tmp/r.log' \
    > /dev/null 2>&1 < /dev/null & disown
  ```
- Um contêiner sem daemon Docker **não** valida o construtor: a criação de
  aplicativo depende dele, e isso é `EB-07`.

---

## Como uma entrega chega ao Prado

Ele trabalha no Windows, com o clone em `deepseek-harness-evoluido`, na branch
`integ`. O envio ao GitHub é `git push origin integ:integ`, **nunca** para
`main`.

Quando o ambiente não alcança o GitHub, o caminho é um bundle incremental. E aí
vale a lição mais cara desta parte: **confira o ponto em que o clone do Prado
está ANTES de escolher a base do bundle.** Quatro bundles seguidos foram
gerados a partir de um commit que só existia do lado de cá, e nenhum deles era
aplicável.

```bash
git bundle create /caminho/saida.bundle <base-do-clone-dele>..integ integ
```

Do lado dele:

```powershell
cd $env:USERPROFILE\deepseek-harness-evoluido
git bundle verify <bundle>
git fetch <bundle> integ:refs/remotes/bundle/integ
git merge --ff-only refs/remotes/bundle/integ
git push origin integ:integ
```

E confira **depois** do envio, comparando o local com o remoto — um script que
anuncia sucesso sem conferir já mentiu uma vez:

```powershell
$a = (git rev-parse integ).Trim()
$b = ((git ls-remote origin refs/heads/integ) -split '\s+')[0]
if ($a -ne $b) { "O ENVIO NAO CHEGOU: local=$a github=$b" } else { "OK $a" }
```

## `gate:lib-freshness` — quanto ele custa, e por que custa

Ele compila o `src/` dos nove plugins que têm `lib/` versionado e compara com o
que o git tem. São **cerca de trinta segundos**, e é o portão mais caro da casa.

O custo é o preço de fechar a lacuna que `gate:tracked-lib` declarava:
`tracked-lib` confere se o artefato está COMPLETO, nunca se ele está EM DIA. Um
artefato desatualizado é a forma mais silenciosa de segunda verdade que este
repositório já produziu — `plugins/tenancy/lib/` ficou parado na OS-23 enquanto
o `src/` chegava à OS-38, e uma correção de autorização nunca esteve em vigor
para quem executasse o pacote.

A compilação sai num diretório temporário **dentro** do pacote
(`plugins/<x>/.lib-freshness-*`, ignorado pelo git) e não em `/tmp`: os
`.d.ts.map` guardam o caminho da fonte relativo ao `outDir`, e compilar para
fora do pacote produziria sessenta falsos positivos — que é como um portão
barulhento deixa de ser lido.

Quando ele reprovar, o conserto é reconstruir o artefato do plugin acusado:

```bash
cd plugins/<plugin> && npx tsc -p tsconfig.build.json
cd - && git add -f plugins/<plugin>/lib
```
