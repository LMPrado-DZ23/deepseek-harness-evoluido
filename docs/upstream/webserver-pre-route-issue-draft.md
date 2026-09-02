# Rascunho de issue upstream — seam `webserver/pre-route`

Status: `NOT_PUBLISHED`

## Problema

Plugins podem registrar rotas exatas ou por prefixo, mas não podem executar uma
verificação comum antes de todas as rotas, inclusive as registradas por outros
plugins. Isso impede que autenticação, correlação e rate limiting sejam compostos
sem proxy externo ou alteração do upstream.

## Proposta mínima

Adicionar um seam ordenado `webserver/pre-route` que receba a requisição e possa:

- continuar para a rota;
- encerrar a resposta;
- anexar contexto tipado à requisição;
- ser removido pelo disposer do plugin.

O contrato deve preservar compatibilidade, ordem determinística, tratamento de
erro fail-closed e testes para rotas exatas, prefixos e ausência de rota.

## Limite de segurança

Mesmo que o seam seja aceito, o DZ23 STUDIO manterá Caddy `forward_auth`, Harness
sem bind público e firewall/rede privada como defesa em profundidade.
