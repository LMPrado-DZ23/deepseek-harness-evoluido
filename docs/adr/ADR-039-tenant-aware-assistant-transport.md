# ADR-039 — Transporte próprio e tenant-aware do Assistente

Status: aceito para implementação incremental; M74-A conclui somente o serviço
interno, sem rota HTTP, SSE ou interface.

## Contexto

A M73 provou que o cliente oficial do Harness autentica o processo, não cada
pessoa, organização e tenant. Ele permanece válido no modo pessoal, mas não
pode ser exposto numa instalação de equipe. O DZ23 STUDIO ainda precisa permitir
que pessoas conversem com o mesmo motor de sessões e agentes sem abrir os
Remotes, o WebSocket ou o log bruto do upstream.

## Decisão

O modo equipe usa um transporte pertencente ao Studio. O servidor conserva o
`SessionController` fixado do Harness como motor interno e publica somente uma
projeção reduzida, autorizada em cada operação.

Cada conversa pertence a exatamente uma sessão de identidade DZ23. Toda leitura,
mensagem e cancelamento exige simultaneamente:

- sessão de identidade ativa e não revogada;
- organização e tenant derivados no servidor;
- papel com `project.read` no escopo atual;
- vínculo exclusivo entre a sessão de identidade e o identificador interno da
  conversa.

Identificadores desconhecidos, de outra pessoa ou com vínculo ambíguo retornam o
mesmo estado público de conversa inexistente. O servidor nunca devolve headers,
`cwd`, configuração, raciocínio, argumentos ou resultados de ferramentas, metadados
de plugin nem eventos desconhecidos. Mensagens são somente texto, limitadas a 32
KiB UTF-8, e a projeção pública é limitada a 500 eventos e 64 KiB por texto.

## Entrega incremental

- M74-A: propriedade exclusiva, serviço de aplicação e sanitização; nenhum
  endpoint ou componente visual;
- M74-B: HTTP e SSE limitados, CSRF, revogação imediata e aprovação de uso único;
- M74-C: interface acessível e E2E adversarial entre dois tenants.

O cliente oficial continua bloqueado no perfil equipe durante todas as etapas.
Uma etapa não muda a capacidade pública antes de a etapa seguinte provar sua
fronteira.

## Limites

O mutex atual evita corridas em um processo. A garantia multi-instância requer
unicidade/transação no armazenamento PostgreSQL; até essa prova, a capacidade
permanece BETA. M74 não substitui a M72/RLS e não autoriza exposição da superfície
bruta do Harness.
