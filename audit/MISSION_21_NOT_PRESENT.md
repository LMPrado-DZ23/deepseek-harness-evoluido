# Missão: os 21 requisitos de v1.0 que não existem

- mission_id: `DZ23-STUDIO-V1-NOTPRESENT-20260908`
- objetivo: implementar os 21 requisitos v1.0 marcados NOT_PRESENT, na ordem em
  que destravam a jornada de uma pessoa leiga, com prova real para cada um
- estado: `PLANNING`
- iteração: 0
- início: 2026-09-08
- base: `49b4958` em `claude/integration-candidate-20260907`
- upstream pinado: `deepseek-harness@6c705be1ce6774a000d061da41d1823b03a3d42c`

## Ordem, e por que esta ordem

A jornada de quem não programa é: escrevo a ideia → respondo perguntas →
aprovo o plano → o Studio cria → **vejo o que aconteceu** → **vejo o que foi
feito** → abro a prévia → decido. O buraco maior está exatamente no meio: hoje
a etapa de criação é uma caixa preta que termina com um código em inglês.

### Onda 1 — a pessoa entende o que aconteceu
1. `E-06` logs traduzidos em etapas, detalhe técnico expansível
2. `E-07` diff dos arquivos, testes, achados e correções
3. `E-11` botão de emergência: parada global
4. `E-08` desfazer, checkpoint GREEN, recuperação

### Onda 2 — a pessoa controla o custo e a privacidade
5. `M-05` + `C-22` três perfis, e o Privado que nunca cai para fora em silêncio
6. `M-06` budget guard e circuit breaker

### Onda 3 — proibição com portão
7. `C-16` portão que impede reintroduzir compressão Caveman/RTK

### Onda 4 — a pessoa acompanha os assistentes
8. `A-08` painel de equipe: árvore/DAG, estado, evidência, arquivos, Parar

### Onda 5 — integrações de verdade
9. `X-01` catálogo pesquisável
10. `X-08` health, timeout, rate limit, retry, auditoria POR integração
11. `X-11` cliente MCP real
12. `H-07` anexos por referência segura

### Onda 6 — infraestrutura profunda
13. `S-09` primeiro domínio migrado do KV opaco para tabela RLS
14. `D-02` staging com artefato imutável

### Onda 7 — P37 antes de qualquer cópia
15-20. `REF-*` seis inventários, com o scanner versionado AQUI

## Critérios de aceite

- cada requisito sai de NOT_PRESENT com implementação E prova;
- nenhuma prova é mock apresentado como integração real;
- toda mudança de estado no ledger tem teste, e a mutação do teste reprova;
- os portões locais continuam PASS;
- nada é apagado do ledger.

## Blockers conhecidos (não encerram a missão)

- `E-05`/atestação de aceitação: decisão do Prado, trava VERIFIED_PROTOTYPE
- `C-05`/SDK proprietário no perfil: trava publicação
- Docker, Windows nativo, celular físico, domínio e SMTP reais
