# ADR-053 — Três idiomas de verdade, e um seletor que não é decorativo

- Estado: Aceita
- Data: 2026-09-18
- Decisor: Leandro Marcos Prado
- Fonte: adendo `FRIGG-CONTA-APOIADOR-INTERNACIONAL-R2`
- Complementa: ADR-052 (marca de apresentação; esta é a língua da apresentação)

## Contexto

O adendo internacional pede português do Brasil, inglês e espanhol **reais**,
com seleção e persistência, e revalidação do diagnóstico de idioma no HEAD
atual. A revalidação foi feita e confirma o que o pacote observou, com dois
números que ele não tinha:

- **14 catálogos** na interface e **19** nos plugins, todos `pt-BR`;
- **50 sítios de importação estática** de catálogo na interface;
- nenhum carregador, nenhuma função `t()` no frontend;
- `preferencias.ts` declarava `idioma` como pendência `idiomaUnico`.

Isso é base de externalização, não seleção trilíngue. O que faltava não era um
motor de tradução — era a segunda e a terceira coluna.

## Decisão

**Expandir a camada que existe, e não instalar um sistema de i18n ao lado.**

1. O idioma vive num **contexto do React** (`IdiomaProvider`), e os catálogos
   dos três idiomas são **importados estaticamente**. Isso os empacota, faz a
   troca ser síncrona e elimina o "flash de idioma incorreto" que uma busca
   assíncrona produz no primeiro render. Funciona offline, sem custo por
   tradução em uso, como o adendo exige.
2. A **precedência** é: escolha explícita desta pessoa agora → preferência
   persistida → negociação BCP 47 do navegador → `pt-BR`. A corrida entre as
   duas primeiras é resolvida pelo **instante**, e não pela ordem de chegada:
   a preferência da conta viaja por rede e chega depois, e deixá-la vencer por
   isso faria a escolha da pessoa piscar na tela e voltar.
3. **`pt-*` cai em `pt-BR`**, inclusive `pt-PT`. Não há catálogo europeu, e
   entregar português do Brasil a quem pediu português é melhor que inglês.
4. A tela mostra **nomes próprios**, não bandeiras: bandeira é país, e a do
   Brasil não representa quem fala português em Portugal.
5. `gate:idiomas` prova o que `gate:i18n` não olha: chave faltando, chave a
   mais, tradução que é cópia do português, interpolação perdida e catálogo
   órfão.

## O que a troca de idioma NÃO faz

Não muda moeda, preço, permissão, tarefa, histórico nem horário de agendamento.
O módulo do idioma não importa nada disso, e essa é a prova mais barata: não há
como. A tela diz isso à pessoa, com essas palavras.

## Consequências

A cobertura é **parcial e declarada**: por enquanto a navegação e a tela de
Preferências estão nos três idiomas; as demais seguem em português e vão sendo
migradas por superfície. O adendo pede entregas verticais, e afirmar cobertura
total antes dela seria a falsidade que ele proíbe — a tela de Preferências
escreve a limitação em cada um dos três idiomas.

Os dezenove catálogos dos plugins e os onze catálogos restantes da interface
continuam em português e continuam sendo importados direto por quem os usa.

Um achado do caminho, registrado porque contradiz a intuição: o navegador do
e2e roda em `en-US`, e o produto **abre em inglês** nele. O caso de teste foi
escrito esperando português, reprovou, e a expectativa é que estava errada — a
negociação estava certa. O parágrafo ficou no teste para impedir que alguém
"conserte" a negociação no futuro.
