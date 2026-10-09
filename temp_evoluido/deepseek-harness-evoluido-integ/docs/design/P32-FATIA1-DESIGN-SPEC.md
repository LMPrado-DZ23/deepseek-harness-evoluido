# P32 fatia 1 — especificação visual vinculante

Data: 03/09/2026

## Referências

- `p32-fatia1-layout-reference.png`: estrutura escolhida pelo Prado.
- `p32-fatia1-dz23-safe-concept.png`: adaptação para a marca e para os limites da fatia 1.
- `apps/studio-web/public/brand/dz23-studio-logo.jpg`: marca oficial.

O layout escolhido prevalece sobre o conceito anterior gerado pelo Codex. A
adaptação segura preserva a composição, a navegação lateral, o painel de
andamento e a apresentação responsiva para celular.

## Sistema visual

- Fundo principal branco verdadeiro.
- Navegação lateral azul-marinho, usando a cor da marca.
- Azul vivo somente para ação primária, etapa atual e foco.
- Bordas cinza-azuladas discretas, raio de 12 px e sombras leves.
- Tipografia de interface sem serifa, com alto contraste e escala legível.
- Ícones de contorno com espessura e dimensões consistentes.
- Densidade baixa a média, sem cartões decorativos ou métricas inventadas.

## Estrutura desktop

1. Navegação lateral: marca, Início, Meus projetos, Acompanhar criação e Ver
   resultado; ajuda e configurações no rodapé.
2. Barra superior: estado real do sistema, notificações e conta.
3. Área principal: título, descrição da ideia, sugestões e ação Continuar.
4. Painel de andamento: cinco etapas e seus estados verdadeiros.
5. Aviso permanente de que o resultado é um protótipo não publicado.

## Estrutura móvel

- Cabeçalho compacto com DZ23 STUDIO.
- Painel de andamento em uma coluna.
- Ações Revisar e Aprovar plano somente quando forem válidas para o estado.
- O aviso de protótipo permanece visível.
- Alvos de toque com no mínimo 44 por 44 px e sem rolagem horizontal.

## Vocabulário obrigatório

As etapas são, nesta ordem: Ideia, Perguntas, Plano, Criação e Verificação.
Todos os textos visíveis vêm dos arquivos versionados de idioma pt-BR.

O texto permanente é:

> Protótipo verificado — não está publicado nem disponível para outras pessoas

## Elementos proibidos nesta fatia

- Publicar, Publicação, preview ou deploy.
- Estados READY, DONE, PUBLISHED ou qualquer tradução que prometa conclusão.
- Afirmação de que a experiência foi validada para pessoas leigas.
- Editor de código, terminal, preços, cobrança, marketplace ou métricas falsas.

## Fidelidade e validação

A implementação deve ser comparada com a referência segura em desktop e
celular. Desvios necessários por acessibilidade, estado verdadeiro ou contrato
de segurança devem ser registrados no ledger de fidelidade; nenhuma diferença
puramente estética é aceita sem decisão do Prado.
