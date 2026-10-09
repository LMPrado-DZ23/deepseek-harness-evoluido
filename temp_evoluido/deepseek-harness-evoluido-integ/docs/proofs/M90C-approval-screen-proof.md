# A tela onde uma pessoa autoriza (08/09/2026)

**Branch:** `claude/integration-candidate-20260907`
**Harness:** `6c705be1ce6774a000d061da41d1823b03a3d42c` — **zero diff**

Depois de M90-A e M90-B o mecanismo estava inteiro, mas a única forma de
confirmar era um `POST` em `/studio/approvals/<id>/confirm`. Para um produto de
pessoas leigas isso é o mesmo que não existir.

## O que passou a existir

1. **Listagem escopada.** `GET /studio/approvals` devolve os pedidos **abertos**
   de quem está perguntando. O escopo é a quádrupla exata — pessoa, sessão,
   organização e inquilino — conferida na persistência, não na tela. O que já
   venceu é expirado na leitura e **não aparece como confirmável**: mostrar um
   pedido morto com um botão seria mentir para quem vai clicar. Não existe, e
   continua não existindo, nenhuma rota de **criação**.
2. **`PendingApprovals.tsx`** — a tela. Fica acima do compositor, porque uma
   permissão esperando é a única coisa que bloqueia o trabalho. Diz em
   português o que foi pedido ("usar um segredo guardado", "acessar a
   internet", "usar a ferramenta bash"), onde, e se exige chave de acesso.
3. **Uma ação desconhecida aparece com o nome técnico**, nunca some. Esconder um
   pedido que existe é pior do que mostrá-lo feio.
4. **Uma linha malformada é descartada** em vez de virar um botão "confirmar"
   que não sabe o que confirma.
5. **Os dois avisos são separados.** Uma leitura que voltou a funcionar não
   apaga o aviso de que a **sua** decisão não foi registrada.
6. **403 numa confirmação T3** vira a frase certa — "confirme com sua chave de
   acesso e tente de novo; sua decisão ainda não foi registrada" — e é tratado
   como algo que vale repetir, porque é a única saída que a pessoa tem.
7. Enquanto uma decisão está em andamento, **os dois botões daquele pedido ficam
   desabilitados**: um clique duplo não vira duas decisões.

## Provas

Mutações na fatia da tela e da listagem:

| # | Mutação | Resultado |
|---|---------|-----------|
| L1 | escopo da listagem ignora pessoa, organização e inquilino | 1 falha |
| L2 | lista também o que já terminou | 1 falha |
| L3 | mostra pedido vencido como confirmável | 1 falha |
| D1 | listagem durável sem filtro de escopo | 1 falha |
| C1 | fundo escuro sem redefinir a cor do texto | 1 falha |
| C2 | identificador de confirmação não validado antes de sair | 1 falha |
| C3 | não filtra linha malformada da lista | 1 falha |

### Um guarda que não podia falhar

C1 **sobreviveu** na primeira rodada, e o motivo importa. O portão de contraste
buscava `color\s*:\s*#` no corpo da regra — e `border-color:#6b5326` **contém**
`color:#6b5326`. Qualquer regra com `border-color` passava sem nunca ter
declarado a cor do texto. As duas buscas foram ancoradas no início da
declaração (`(?:^|;)\s*color\s*:\s*#`).

Com o portão consertado, ele **imediatamente encontrou um defeito real que
estava lá antes**: no modo escuro, `.conversation-log` escurecia o fundo
(`#0c111c`) sem redefinir a cor do texto. Corrigido no mesmo commit.

## Portões

- `tsc --noEmit` **PASS** (raiz e `apps/studio-web`)
- `apps/studio-web`: **115 testes passaram** (21 arquivos)
- Suíte completa com PostgreSQL real: **2179 passaram**, 3 falhas ambientais em
  `builder-supervisor` (uid 0; como usuário não privilegiado passam 103/103)
- Cobertura: **zero violações de limiar** (96,11% stmts / 93,57% branches);
  `model`, `repository`, `service`, `http` e `domain` do `action-approval` em
  **100%**
- `I18N_GATE=PASS catalogs=15` — os rótulos da tela foram para o catálogo, como
  manda a regra de copy localizada; literais herdados **não** cresceram
- `DOMAIN_ROUTE_GATE=PASS domains=26` · `domain-scopes` PASS
- `ASSISTANT_TOOL_CATALOG=PASS` · `PORTABILITY=PASS findings=0`
- `UPSTREAM_PIN=PASS commit=6c705be1` — **o Harness não foi tocado**
- **P37** `PASS · 471 arquivos · 19 manifests · 1 licença · 0 achados`

## O que isto ainda NÃO é

- **Não foi visto por uma pessoa leiga.** A fase 0.5 com cinco pessoas continua
  `BLOCKED_EXTERNAL` (E4/ADR-016) e só vale sobre o sistema completo.
- **Não foi visto num celular físico.** O layout é responsivo e o contraste é
  calculado, não procurado por string, mas nada disso substitui um aparelho.
- Sem merge, sem push, sem deploy, sem Docker.
