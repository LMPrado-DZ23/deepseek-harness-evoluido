# ADR-052 — FRIGG é marca de apresentação, e apresentação não é origem

- Estado: Aceita
- Data: 2026-09-18
- Decisor: Leandro Marcos Prado
- Fonte: decisão de marca `FRIGG-MARCA-20260917-R1`
- Complementa: ADR-050 (que fixou a marca do proprietário na casca aprovada)

## Contexto

O proprietário decidiu que a marca visível do produto passa a ser **FRIGG**, e
que o domínio escolhido é **frigg.ia.br**. O DZ23 permanece como origem e
ecossistema; o DeepSeek permanece como núcleo técnico.

Duas coisas tornam essa decisão perigosa se executada sem regra escrita.

A primeira é que o nome do produto estava escrito **à mão em onze lugares** —
`index.html`, manifesto da PWA e nove catálogos de tradução — e nenhum teste
comparava um com o outro. Trocar dez e esquecer um produz um produto que exibe
duas marcas ao mesmo tempo, e a que ficar errada é justamente a que ninguém
olha. É a segunda verdade, o defeito mais caro deste repositório.

A segunda é que "trocar o nome" convida à busca e substituição global, e este
produto tem identificadores que **não são nome**: pacotes `@dz23-*`, serviços
Cordis, tabelas, domínios de dados, variáveis `DZ23_*`, caches, o cookie de
sessão, o RP ID das chaves de acesso, os callbacks OAuth e — o mais silencioso
de todos — `id`, `scope` e `start_url` do manifesto. Trocar esses três faz o
navegador tratar a PWA já instalada como **outro aplicativo**, e quem tinha o
produto instalado perde o que estava lá.

## Decisão

**FRIGG é marca de apresentação.** Ela muda o que se vê e nada do que se
resolve.

1. O valor da marca mora em **uma fonte**, `apps/studio-web/src/marca/marca.ts`.
   Nenhuma tela escreve o nome do produto à mão.
2. `gate:marca` confere os dois lados: que todas as superfícies concordem com a
   fonte, e que a identidade de instalação do manifesto **não** mude junto.
3. O domínio escolhido é uma constante com `dominioPublicado: false`. Escolher
   não é registrar, apontar, certificar nem servir, e o portão reprova qualquer
   texto de interface que escreva o domínio enquanto isso for falso.
4. A escolha de qual arte usar em cada tamanho foi **medida**, e a medição está
   versionada em `audit/FRIGG_MARCA_R1/comparacao-marca.png`: o emblema
   sobrevive de 36 px para cima e vira mancha abaixo disso, então o favicon usa
   o micro-F derivado do próprio lettering. Um não substitui o outro — cada um
   tem sua faixa declarada.
5. O lettering artístico **não** entra no corpo do aplicativo. O trilho continua
   emblema compacto ao lado do nome em texto, na tipografia do produto, como a
   referência aprovada mostra.

## Consequências

Ficam **de fora**, declarados e não escondidos: o instalador do Windows, a frase
de confirmação destrutiva `APAGAR DADOS DO DZ23 STUDIO` e o manifesto assinado
da fase 05. São contratos de operador e metadado assinado; renomeá-los por
branding invalidaria em silêncio todo procedimento escrito, e cada um precisa do
seu próprio delta com o seu próprio teste.

O registro, o DNS, o certificado e a migração de origem de `frigg.ia.br` são um
delta separado, que não foi iniciado. Nada de DNS, TLS, cookie, RP ID, callback
OAuth, CORS ou origem de API foi tocado por esta decisão.

O aceite visual do titular **não** está declarado: a conferência registrada é a
do executor, sobre as capturas versionadas.
