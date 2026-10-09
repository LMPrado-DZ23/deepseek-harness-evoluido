# P35 — Prova 7.6 do Hermes Agent (somente leitura)

Data: 2026-09-03. Nenhum código foi copiado, instalado ou executado.

## Fonte examinada

- arquivo: `hermes-agent-main (1).zip`;
- SHA-256: `AC531EA12E9692E5D4907796F03C7DD176CF06F77FB97309CD1DB81E2F345F4D`;
- origem declarada e confirmada: `https://github.com/NousResearch/hermes-agent`;
- versão no snapshot: `0.21.0`;
- commit: **não comprovado para a árvore inteira** porque o ZIP não contém `.git`
  nem build SHA. O candidato `c0495c6bce6c4988f79a2e0355e5aa047a3b03af`
  teve `hermes_cli/oneshot.py` e `hermes_cli/_parser.py` comparados byte a byte e
  idênticos; rate limit HTTP impediu baixar a árvore inteira. Logo o candidato
  é evidência parcial, não pin de origem.

## Achados

Há modo não interativo:

- `hermes_cli/_parser.py:34-40`: `-z/--oneshot` e `--usage-file`;
- `hermes_cli/oneshot.py:159-197`: sidecar JSON estruturado de uso;
- `hermes_cli/oneshot.py:202-225`: execução de um único prompt;
- `hermes_cli/oneshot.py:253-265`: modo stateless e aprovação automática;
- `hermes_cli/oneshot.py:267-338`: stdout contém só texto final e exit code.

Esse modo **não é aceitável diretamente** para o Studio: o resultado principal
não é estruturado e `HERMES_YOLO_MODE=1` desvia aprovações.

Também há gateway JSON-RPC estruturado:

- `tui_gateway/server.py:2521-2529`: eventos em frames JSON-RPC;
- `tui_gateway/server.py:2987-3038`: resultado/erro e dispatch;
- `tui_gateway/methods_prompt.py:287` e `:1050-1058`: `prompt.submit` com estado
  de streaming;
- `tui_gateway/methods_session.py:3383-3421`: `session.interrupt`;
- `tui_gateway/server.py:1234-1276`: interrupção e hard interrupt.

## Conclusão

**VIÁVEL PARA PESQUISA v1.x, NÃO INTEGRADO.** O gateway JSON-RPC é uma base mais
segura que o modo oneshot, pois tem eventos e cancelamento estruturados. Antes de
qualquer adapter seriam obrigatórios isolamento, autenticação do gateway,
limpeza de ambiente, controle de ferramentas, teste de árvore de processos e
prova de que a aprovação do Studio não é contornada.

