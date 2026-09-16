# ADR-050 — O workspace aprovado, e a marca do proprietário

- Estado: Aceita
- Data: 2026-09-16
- Decisor: Leandro Marcos Prado
- Substitui parcialmente: ADR-003 (a parte do arquivo de logotipo oficial)

## Contexto

O pacote V6 trouxe duas imagens de referência (`ref-home.png`,
`ref-workspace.png`), o PNG original da marca (`logo-dz23-original.png`) e uma
especificação visual. **Nada disso tinha sido aplicado.** Nove entregas
seguidas mexeram em motor — segurança, autoridade, orçamento, portões — e
nenhuma mudou um pixel. O Prado perguntou duas vezes por que o sistema não
tinha mudado, e a resposta honesta era que o trabalho visual não tinha sido
feito.

## Decisão

**1. A estrutura principal de apresentação passa a ser o workspace da
referência**, e não a jornada de cinco etapas repintada.

- A entrada principal (`/studio/`) abre a nova home: título centrado,
  compositor amplo, atalhos.
- A casca (`shell/WorkspaceShell.tsx`) é a MESMA em toda tela do produto.
  Antes a tela inicial montava a própria casca e as outras recebiam outra, e as
  duas divergiram.
- A jornada de cinco etapas não desaparece: ela deixa de ser a home obrigatória
  e vira painel de contexto dentro da tarefa, onde informa alguma coisa.
- Tipo, aparência e privacidade continuam existindo inteiros, com os mesmos
  controles e as mesmas frases, um nível abaixo, em "Ajustes desta tarefa".
  Nenhuma função sumiu por ter mudado de lugar.

**2. A marca oficial passa a ser `referencias/logo-dz23-original.png`**, do
proprietário, versionada intacta em
`apps/studio-web/public/brand/dz23-original.png`
(SHA-256 `30700b93767266afe0447aafd6f628ab20096b66909ddbdce34af1ed5047e264`,
somente leitura).

- Os derivados (`dz23-mark-48/96/256.png` e os três ícones) saem dela por
  `scripts/build-brand-assets.mjs`: corte da margem externa branca pela caixa
  delimitadora, quadratura e redução LANCZOS.
- O fundo azul **não** é removido, a marca **não** é revetorizada e **não** há
  filtro de inversão para o tema escuro. A especificação avisa que a extração
  malfeita come letras e contornos; o ícone original bem dimensionado é
  preferível a uma extração ruim.
- `dz23-studio-logo.jpg` continua versionado e não é apagado, mas deixa de ser
  a marca apresentada na interface.

## Consequências

- `src/Navigation.tsx`, `src/StudioShell.tsx` e a lista de itens em
  `src/navigation.ts` foram substituídos por `src/shell/` (`rail.ts`,
  `Rail.tsx`, `WorkspaceShell.tsx`). `navigation.ts` ficou só com
  `STUDIO_HOME_PATH`.
- `Navigation.spec.tsx` foi substituído por `shell/Rail.spec.tsx`, que carrega
  uma tabela ligando cada comportamento coberto antes ao teste que o cobre
  agora. A contagem caiu de 8 para 7 porque dois testes viraram um; nenhuma
  asserção foi afrouxada.
- O corte do celular passou de 820px para 1024px, decidido pelo CONTEÚDO: o
  trilho novo tem `clamp(260px, 20vw, 320px)` e abaixo disso come a coluna de
  leitura.
- A gaveta fechada passou a ser `visibility: hidden`. Antes ela só era
  deslocada para fora da tela, o que a mantinha no foco do teclado e na árvore
  do leitor de tela.

## O que esta decisão NÃO autoriza

Publicação, deploy, release pública ou alteração em produção. O texto do Prado
é explícito: "Esta decisão não autoriza publicação, deploy ou alterações
perigosas em produção."

## Limitação declarada

"Agendado" e "Biblioteca" aparecem no trilho da referência e **não** estão no
trilho implementado: não existe tela para nenhuma das duas neste produto, e a
própria especificação proíbe cliques sem resultado. Entram quando existirem,
com destino, como todas as outras.
