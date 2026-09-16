# Operação — como rodar e como provar

Os comandos, com os caminhos e as variáveis que de fato funcionam. Tudo aqui
foi executado; nada é sugestão.

Para **abrir o produto**, o caminho é [`COMECAR.md`](./COMECAR.md). Para
**instalar do zero com verificação**, é [`BOOTSTRAP.md`](./BOOTSTRAP.md). Este
arquivo é para quem vai **mexer no código**.

---

## Os 24 portões

Rodam em qualquer ordem, e todos precisam sair com `EXIT=0`:

```
typecheck      lib-freshness
domain-scopes  domain-routes  assistant-tools  team-role-tools  rls-coverage
upstream-pin   portability    i18n             comprehension    vocabulary
memory-map     constitution   tracked-lib      image-lock
decision-record  requirements-ledger  secrets   no-caveman      p37
candidates     vendored-references  licenses
```

Um de cada vez é `pnpm gate:<nome>`. Todos de uma vez, guardando os vereditos
que a constituição depois confere:

```bash
G=(typecheck lib-freshness domain-scopes domain-routes assistant-tools team-role-tools
   rls-coverage upstream-pin portability i18n comprehension vocabulary memory-map
   constitution tracked-lib image-lock decision-record requirements-ledger
   secrets no-caveman p37 candidates vendored-references licenses)
FAIL=0
: > /tmp/verdicts.txt
for g in "${G[@]}"; do
  if pnpm "gate:$g" > "/tmp/gate-$g.log" 2>&1; then echo "OK   $g"
  else echo "FAIL $g"; FAIL=1; fi
  grep -E '^[A-Z_]+=(PASS|FAIL)' "/tmp/gate-$g.log" >> /tmp/verdicts.txt
done
echo "GATES_FAIL=$FAIL"
```

Depois, **sempre**, a conferência da constituição — ela lê os vereditos que o
laço acima acabou de gravar, e sem o arquivo ela não tem o que conferir:

```bash
node scripts/check-constitution.mjs --verdicts /tmp/verdicts.txt
```

Saída esperada: `CONSTITUTION=PASS clausulas=14 PORTÃO=9 CÓDIGO=1
NÃO_AUTOMATIZADO=4 vereditos_conferidos=33`.

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
export DZ23_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome
npx playwright test
```

São 117 testes em quatro tamanhos de tela. Se um servidor de teste ficar
pendurado, mate-o com a forma em colchete — sem ela o `pkill` casa com o
próprio comando e mata a si mesmo:

```bash
pkill -9 -f 'tests/serve[r].ts'
```

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
