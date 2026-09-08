# ADR-040 — WebMCP: o Studio como provedor, e a linha que ele não cruza

Data: 08/09/2026. Estado: aceito. Autor: Claude (Opus 5), a pedido de Prado.
P37 correspondente: `docs/inventory/p37/webmcp.md`.

## Contexto

WebMCP é uma proposta do W3C Web Machine Learning group: a partir do Chrome 149
(origin trial) uma página pode registrar ferramentas em `document.modelContext`,
e um agente do navegador as descobre e as executa. É a inversão do MCP que o
DZ23 já tem: em `plugins/mcp-client` o Studio é CLIENTE e chama servidores de
terceiro; aqui o Studio é PROVEDOR e é chamado.

Quem chama não é o Studio e não é a pessoa. É um programa de terceiro rodando
dentro do navegador dela, na mesma sessão autenticada, com o mesmo cookie. O
explicador da especificação chega a recomendar "Trust the agent" ao redigir
descrições — conselho de ergonomia que, lido como conselho de segurança, seria
a permissão para transformar toda a arquitetura de confirmação deste produto em
enfeite.

O produto inteiro é construído sobre uma ideia oposta: ações sensíveis exigem
confirmação humana explícita, emitida pelo servidor, com nível, sujeito e
prazo (ADR-039). Registrar uma ferramenta "aprovar plano" entregaria a um
agente exatamente a decisão que essa arquitetura existe para reservar à pessoa.

## Decisão

O DZ23 implementa WebMCP como PROVEDOR, e só isso, com quatro linhas fixas:

1. **Nenhum caminho privado.** Toda ferramenta chama as MESMAS rotas do
   produto, com o mesmo cookie de sessão e o mesmo CSRF. O que o servidor
   recusaria à pessoa, recusa ao agente — autorização, escopo e confirmação são
   idênticos. A porta é um arquivo só (`webmcp/studioPort.ts`), para ficar
   impossível uma ferramenta abrir atalho.
2. **Nenhuma decisão da pessoa é exposta.** Não existe, e não passa a existir,
   ferramenta para aprovar plano, mandar gerar, publicar, ligar/desligar ou
   remover integração, mexer em segredo, ou apertar a parada de emergência. Há
   teste que reprova se um nome dessas famílias aparecer no catálogo.
3. **Nada é exposto a origem de terceiro.** Nenhum `exposedTo` é passado: o
   teto é o padrão da própria especificação — mesma origem e agente embutido do
   navegador.
4. **Desligado por padrão, e o desligar desliga.** A pessoa liga por navegador,
   numa tela que diz o que fica exposto e o que nunca fica. Desligar ABORTA o
   `AbortSignal` do registro, o que tira as ferramentas do catálogo do agente —
   esconder o botão deixaria as ferramentas registradas.

O catálogo é pequeno de propósito: três ferramentas, todas de leitura salvo a
criação de RASCUNHO, que não planeja nem constrói nada e diz isso na própria
resposta que o agente lê.

## Alternativas consideradas

**Não fazer nada.** Descartada: o pedido é explícito, e a superfície é
implementável com risco contido e desligada por padrão.

**Expor o Studio inteiro como ferramentas.** Descartada, e é a alternativa
perigosa: seria a arquitetura de confirmação contornada por um caminho novo, e
o agente é o único ator do sistema que ninguém autenticou.

**Usar uma biblioteca que emula WebMCP** (por exemplo os exemplos de
`WebMCP-org`). Descartada nesta rodada: exigiria P37 próprio, entraria no SBOM
e no lockfile, e a API nativa não precisa dela.

**Fazer os aplicativos GERADOS registrarem ferramentas** — "seu aplicativo
funciona com agentes". É uma frente legítima e provavelmente valiosa, mas é
outro requisito, com outro risco (o aplicativo é de terceiro para a pessoa que
o usa), e não entra por tabela nesta decisão.

## Consequências

- Um agente do navegador consegue listar projetos, ler estado e plano, e
  começar um rascunho — e nada além disso.
- O caminho de navegador REAL não está provado e não é declarado como provado:
  `document.modelContext` não existe no Chromium deste ambiente. O que existe é
  prova contra um dublê fiel da superfície da API, mais uma prova em navegador
  real de que a DETECÇÃO DE CAPACIDADE funciona e nada é registrado onde a API
  não existe.
- O estado ligado/desligado vive no `localStorage` do navegador. É fraco como
  garantia (não atravessa dispositivos, some com a limpeza de dados) e é
  adequado ao alcance (o agente também é daquele navegador). Leitura que falha
  vale como DESLIGADO: armazenamento bloqueado não é consentimento.
