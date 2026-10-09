# ADR-054 — Apoio voluntário existe; pedágio não

- Estado: Aceita
- Data: 2026-09-18
- Decisor: Leandro Marcos Prado
- Fonte: decisão do titular (PIX de doação) + adendo `FRIGG-CONTA-APOIADOR-INTERNACIONAL-R2`
- Altera: ADR-009 (open source sem faturamento) — na parte do apoio, e só nela
- Complementa: ADR-052 (marca FRIGG)

## Contexto

A cláusula 1.3 da constituição diz que o produto é "open source e **sem
cobrança**: nada de assinatura, plano pago, crédito vendido, paywall, comissão,
Stripe, checkout ou tela de upgrade (ADR-009)".

Duas decisões do titular tocam essa linha:

1. **um PIX de doação**, para quem quiser apoiar o projeto;
2. **FRIGG Apoiador**, plano opcional de USD 5 por ciclo mensal, do adendo
   internacional.

Escrever qualquer uma das duas sem mexer aqui seria produzir a contradição mais
cara que este repositório conhece: o código dizendo uma coisa e a constituição
dizendo a oposta, com a constituição sendo o documento que alguém lê para
decidir o que pode.

## Decisão

A cláusula 1.3 deixa de proibir **apoio** e passa a proibir **pedágio**. A
diferença não é de palavra, é de efeito:

**Permitido, porque não condiciona nada:**

- doação voluntária, de valor livre, por PIX ou meio equivalente;
- um plano de apoio opcional, com preço declarado.

**Proibido, e isto é o que a cláusula realmente protegia:**

- qualquer funcionalidade local atrás de pagamento;
- limite, cota, marca d'água, expiração ou degradação que só saia pagando;
- tela de upgrade, paywall, contagem regressiva ou pedido de pagamento
  colocado no caminho de quem só quer usar o produto;
- cobrança automática, cobrança por inferência de intenção, ou apoio que vire
  requisito de instalação, atualização ou uso.

**O teste de uma linha:** desligar o apoio, cancelar, perder a conexão com o
portal ou nunca ter doado **não pode mudar nada** do que a instalação local faz.
Se muda, é pedágio, e a cláusula proíbe.

## Consequências

O que entra agora é só a **doação**: um QR e uma chave para copiar, no README e
na página de apoio. Ela não aparece dentro do produto no caminho de nenhuma
tarefa.

`FRIGG Apoiador` continua **não implementado** — não há conta, cobrança,
gateway, cotação nem benefício em lugar nenhum do código. Esta ADR autoriza o
desenho; ela não é a implementação, e o adendo é explícito que gateway,
benefícios, impostos e termos ainda dependem de decisão e homologação.

O payload do PIX mora em **um** arquivo (`docs/pix-payload.txt`), porque ele
aparece em dois lugares para quem lê — o QR que se escaneia e o texto que se
copia. Dois lugares com o mesmo dado escrito à mão é a segunda verdade de
sempre, e aqui ela não produziria um rótulo errado: produziria dinheiro indo
para o lugar errado, ou para lugar nenhum. `gate:pix` confere o CRC-16 do BR
Code e que o README cite a fonte byte a byte.

O que esta ADR **não** decide: se haverá recibo, nota fiscal, contrapartida,
reembolso ou qualquer obrigação do projeto para com quem doa. Doação é doação.
