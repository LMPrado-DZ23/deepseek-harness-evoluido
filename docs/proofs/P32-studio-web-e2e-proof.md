# P32 — Interface em navegador, sessão e acessibilidade

- Resultado: **PASS** (`2/2` testes Playwright).
- Servidor HTTP efêmero com `createPromptToAppHttpHandler`,
  `PromptToAppService` e repositório em memória: PASS.
- `/studio` sem sessão: `401`.
- `/api/studio/apps/health` sem sessão: `401`.
- Sessão e CSRF na jornada autenticada: PASS.
- Quatro cartões de aparência e gravação tenant-aware do DesignSpec antes das
  perguntas: PASS.
- Jornada: Ideia → Perguntas → Plano → pedido de mudança → plano revisado →
  aprovação → Criação → Verificação: PASS.
- Texto de privacidade local e identificação da rota `ollama-local`: PASS.
- Estado final visível: `VERIFIED_PROTOTYPE`, acompanhado do aviso de não publicação.
- `POST /generate` respondeu `202`; a interface acompanhou o job por polling.
- Plano completo com duas fatias apareceu antes da aprovação no viewport móvel.
- Resultado mostrou por critério `Passou` ou `Não verificado automaticamente`.
- Auditoria axe no estado final: zero violações.
- Execução final após as correções: **2/2 PASS** no contêiner Playwright
  fixado, com `--network none`, usuário `10001:10001`, `CapDrop=ALL`,
  `no-new-privileges`, raiz e dois bind mounts somente leitura, além de limites
  de CPU, memória, processos e memória compartilhada. O Harness fixado foi
  montado separadamente e somente para resolver os links locais dos pacotes.
- Imagem: `sha256:c2011c57e0d8a2a66abb8626b53b2ef0abeedd7675ba4593924ee7bb99f2b33e`.

O LLM e o construtor são portas determinísticas, mas toda a jornada usa o
handler, os schemas, o serviço, a máquina de estados e o job service reais. O
Docker real continua coberto pelas provas de isolamento e do template. Este
teste não usa LLM real, não abre preview e não publica nada.
