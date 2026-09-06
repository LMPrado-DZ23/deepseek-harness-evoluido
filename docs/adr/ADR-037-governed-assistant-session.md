# ADR-037 — Sessão governada do Assistente no Harness

Status: aceito para BETA pessoal/dispositivo em M71.

## Contexto

A entrada `/studio/assistente` já existia, mas apenas encaminhava a pessoa ao
chat do Harness. Ela não criava uma conversa com o preset seguro, não fixava o
repositório autorizado e não vinculava a sessão do Harness à identidade do
Studio.

O chat continua pertencendo ao Harness. Duplicar sua interface, seu histórico
ou seu protocolo no Studio criaria duas autoridades concorrentes e uma falsa
sensação de isolamento.

## Decisão

O Studio expõe `POST /studio/assistant/session`. A rota exige sessão de
identidade ativa, origem local, CSRF e membership com `project.read`. O corpo
não aceita organização, tenant, workspace, repositório, caminho ou preset: toda
essa autoridade vem da sessão e da configuração protegida
`assistantRepositories`.

Para cada sessão de identidade, o launcher cria ou retoma uma sessão real por
`sessionController.create`, sempre com:

- `cwd` igual ao caminho canônico do único repositório configurado para o
  par organização/tenant;
- `agentPreset: dz23-assistant`;
- vínculo persistido em `harness_session_ids` da sessão de identidade.

Uma sessão existente só é retomada depois de `inspect` confirmar o mesmo preset
e o mesmo `cwd`. Sessão ausente é ignorada; falha de inspeção, conflito de
repositório ou adoção com outro preset falha fechada. O servidor registra apenas
a fase e o erro interno; o HTTP devolve texto genérico em pt-BR.

No navegador, depois da resposta validada, o Studio grava a seleção que o
cliente oficial do Harness já usa (`dsh.sessions.current`) e segue para
`/api/studio/identity/harness/session`. A conversa, o streaming e o histórico
permanecem implementados exclusivamente pelo Harness.

O plugin `assistant-bridge` é montado dentro de `cordis:group` com
`isolate.studioAssistant: true`. O serviço é propriedade da sessão do Harness,
não um singleton do processo; as treze ferramentas e seus consumidores ficam no
mesmo grupo isolado.

## Consequências e limites

- Uma instalação pessoal pode abrir e retomar uma conversa real com o preset
  governado e o repositório correto.
- Revogar a sessão do Studio impede a próxima abertura.
- O mutex evita duas criações simultâneas dentro do mesmo processo.
- Uma sessão recém-criada com preset divergente é recusada; sua limpeza física
  depende do lifecycle do Harness e não é afirmada nesta fatia.
- A listagem e o histórico de sessões do cliente atual do Harness não possuem
  isolamento por tenant. Uso simultâneo por várias pessoas na mesma instalação
  é `NOT_SUPPORTED`, não apenas pendência de teste.
- Turno com modelo real, redirecionamento em navegador real, PostgreSQL físico,
  reinício, celular e operação prolongada continuam `NOT_EXECUTED`.

## Evidência exigida

- boot real do profile no pin do Harness;
- login real, negativa sem CSRF e negativa após revogação;
- criação e inspeção reais da sessão com preset e `cwd` exatos;
- treze ferramentas governadas visíveis no Agent da sessão;
- segunda abertura retomando o mesmo ID;
- testes de unidade com cobertura crítica de 100%;
- pacote staged e preset isolado verificados;
- clone limpo antes de promover esta decisão para integração.
