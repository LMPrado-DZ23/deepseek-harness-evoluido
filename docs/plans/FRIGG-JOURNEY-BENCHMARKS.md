# FRIGG: avaliação por jornada, sem superioridade presumida

Plano de avaliação de 20/09/2026. Comparação externa: **NOT_EXECUTED**.
Este documento define o protocolo; não transforma uma intenção em resultado.
O livro mestre continua sendo a autoridade dos estados do produto.

## Escopo e arquitetura

O DeepSeek Harness permanece como único orquestrador, no pin de `UPSTREAM.lock`.
Web, PWA e futuros clientes desktop/mobile devem usar as mesmas autoridades de
identidade, permissões, tarefas, arquivos, aprovações, execução e histórico.
Não criar um segundo motor para imitar uma interface de referência.

O alvo é uma jornada geral utilizável por quem não programa: conversar,
pesquisar, operar ferramentas com autorização, produzir arquivos, criar e
alterar um aplicativo, acompanhar agentes, interromper, exportar e retomar.
Uma PWA validada em viewport móvel não é um aplicativo nativo validado.

## Protocolo reproduzível

1. Versionar os briefs, arquivos de entrada e critérios de aceite antes das
   execuções. Reservar um conjunto cego que não seja usado para ajustar prompts.
2. Registrar SHA do FRIGG, versão/data/plano do comparador, sistema operacional,
   CPU/GPU/RAM, navegador, provedor/modelo e parâmetros, topologia de rede,
   política de privacidade, orçamento, limites e cache frio/quente.
3. Para cada cenário, executar ao menos cinco repetições por produto. Manter os
   mesmos dados, objetivos, limites, permissões e intervenções permitidas.
   Se o comparador não expõe seu modelo ou custo, registrar **desconhecido**;
   não pressupor igualdade nem usar zero.
4. Medir tempo de parede e tempo de trabalho humano separadamente. Preservar
   falhas, cancelamentos e timeouts no denominador. Nunca selecionar apenas a
   melhor tentativa nem continuar além do orçamento sem contabilizar a mudança.
5. Guardar traces e artefatos sem segredos ou dados pessoais reais. Identificar
   cada tentativa com `run_id`, `journey_id`, SHA do dataset e hash do artefato.
6. Avaliar artefatos contra critérios observáveis definidos antes da geração.
   Revisão humana deve ser cega quanto ao produto quando isso for viável.
7. Publicar amostra, sucessos/total, mediana, p95, dispersão, custos conhecidos,
   intervenções e limitações. Cinco repetições são um piloto, não base para
   alegação estatística ampla; ampliar a amostra e calcular intervalos antes
   de afirmar vantagem consistente.
8. Só comparar células equivalentes. Resultado local offline e serviço cloud
   pertencem a estratos distintos. Uma vantagem em exportação não implica
   vantagem em pesquisa, segurança ou qualidade de código.

## Matriz de jornadas

| ID | Jornada e dado de entrada | Aceite observável | Evidência necessária |
| --- | --- | --- | --- |
| J01 | Instalação limpa → primeira conversa | Usuário chega à primeira resposta sem editar configuração à mão; falta de dependência é explicada | Gravação, passos, minutos e intervenções em Windows/WSL, Linux e macOS separadamente |
| J02 | Conversa com PDF, planilha, imagem e texto | Arquivos preservados byte a byte; conteúdo usado com procedência; tipo/modelo incompatível explicado | Upload/download por hash, resposta revisada e limites reais por tipo |
| J03 | Pesquisa com fontes contraditórias | Afirmações ligadas às fontes, datas corretas, incerteza explícita e nenhuma fonte inventada | URLs, trechos curtos de suporte, data de acesso e verificação humana |
| J04 | Navegador supervisionável | Ações visíveis, pausa/cancelamento efetivos e confirmação antes de efeito sensível | Trace do navegador e prova do efeito recusado após cancelamento |
| J05 | Editar projeto existente em pasta autorizada | Correção satisfaz o teste que reproduz o defeito, preserva funcionalidades e não lê/grava fora do escopo | Diff, testes, arquivos sentinela externos intactos e ataques de caminhos/links |
| J06 | Plano → execução com dois subagentes | Responsabilidades e dependências visíveis; teto compartilhado; erro de um agente não vira sucesso global | Trace por tarefa/agente/ferramenta, custo agregado e cancelamento |
| J07 | Prompt → aplicativo → prévia → alteração | Build, dados, validação, controles e alteração funcionam na prévia real; nenhuma ação simulada | Modelo real, relatório de aceite, navegador e artefato exportado |
| J08 | Arquivo final exportado e reaberto | Exportação portátil contém o necessário, sem segredo, com instruções que funcionam fora do FRIGG | Hash, inspeção e execução em ambiente limpo |
| J09 | Interrupção e reinício | Conversa e tarefa retomam de checkpoint consistente; efeito externo não é duplicado | Reinício do processo, reinício do computador e idempotência medidos separadamente |
| J10 | Agendamento | Criar, visualizar, pausar e cancelar; fuso e horário de verão tratados; cancelado não dispara | Relógio controlado nos testes e pelo menos um disparo real registrado |
| J11 | Privado local com provedor indisponível | Nenhum fallback externo, nenhuma saída de conteúdo; bloqueio recuperável e compreensível | Captura de egresso, logs redigidos e provedor local desligado durante a jornada |
| J12 | Outro usuário/tenant tenta acessar tarefas e arquivos | API recusa leitura, escrita e inferência por IDs; cache/jobs/storage não cruzam escopos | Dois tenants reais, matriz negativa e evidência no servidor/banco |

## Dimensões e limites de interpretação

| Dimensão | Medida | Critério de liberação proposto |
| --- | --- | --- |
| Cobertura funcional | Jornadas concluídas/planejadas, por plataforma | Não marcar uma capacidade como disponível só porque existe botão ou contrato |
| Qualidade | Critérios de aceite satisfeitos/total; regressões | Nenhuma falha obrigatória de aceite escondida por média |
| Custo | Provedor, infraestrutura, tempo humano e retries | Custo desconhecido separado de custo zero; teto respeitado |
| Latência | Primeiro feedback, primeiro resultado útil e conclusão; mediana/p95 | Fixar orçamento por jornada e hardware antes de medir; cancelar sempre disponível |
| Segurança | Ataques de autorização, caminhos, prompt injection, SSRF e supply chain | Zero falhas críticas/altas abertas no escopo de lançamento; testes negativos com mutação |
| Privacidade | Destinos contatados e classes de dados transmitidas | Perfil local sem egresso de conteúdo; consentimento explícito para cloud |
| Acessibilidade | WCAG 2.2 AA aplicável; teclado, foco, zoom e leitor de tela | Axe complementa, não substitui, inspeção manual e tecnologia assistiva |
| Exportação | Importação/execução externa, integridade e ausência de segredos | Artefato real reaberto em ambiente limpo |
| Recuperação | Trabalho perdido, efeitos duplicados e tempo para retomar | Nenhuma perda silenciosa ou repetição de efeito sensível |
| Transparência | Plano, progresso, ferramentas, custos e razões de bloqueio | Distinguir executado, simulado, não executado e bloqueado |
| Usabilidade | Conclusão sem ajuda e erros de compreensão | Piloto com cinco leigos; alvo inicial 4/5 nas jornadas escolhidas, sem alegar validação universal |

## Uso das referências

Estas são perguntas de pesquisa, não afirmações sobre versões atuais dos
produtos. Cada adoção exige inventário P37, licença, versão, custo e avaliação;
conceitos podem inspirar o desenho sem copiar código ou marca.

| Referências solicitadas | Pergunta para o FRIGG |
| --- | --- |
| Manus Desktop/Web/Mobile, Devin, Replit Agent | A tarefa geral fica compreensível do pedido à retomada e à entrega? |
| OpenHands, Cline, Aider, Claude Code, Codex, Cursor, Windsurf | O agente modifica um projeto existente com diff, contexto suficiente, testes e autorização? |
| Zed | Qual é a latência percebida da interface? Somente princípios, sem incorporar código, conforme a constituição |
| Roo Code | Há padrões históricos úteis a estudar? Não adicionar dependência, conforme a constituição |
| v0, Lovable, Bolt, Builder.io, FlutterFlow | O resultado visual atende ao negócio, permanece editável e exportável e tem fluxos reais? |
| Perplexity/Wide Research | As conclusões têm fontes rastreáveis e a pesquisa paralela preserva contradições? |
| MetaGPT, ChatDev, AutoGen, CrewAI | Papéis e dependências melhoram o resultado medido ou só multiplicam chamadas e custo? |
| Ollama, vLLM, Lemonade | Qual backend local atende ao hardware, privacidade e prazo da jornada sem fallback oculto? |
| E2B | Quais propriedades de isolamento e recuperação precisam de prova no sandbox já existente? |

## Sequência de evolução

1. **P0 — preservar dados e autoridade:** corrigir achados reproduzidos nesta
   auditoria, ligar regressões na CI e repetir as quatro suítes. Arquivos e
   artefatos são parte da superfície de segurança, não apenas conveniência.
2. **P1 — jornada geral completa:** fechar J01/J02/J05/J06/J08/J09/J10 no
   produto montado com modelo real. O registro de uma criação com Mistral é
   evidência daquela execução, não da jornada inteira nem de todos os modelos.
3. **P1 — privacidade e escopos:** executar J11/J12 contra serviços reais e
   falhas induzidas; conferir o egresso, não só a configuração.
4. **P2 — pesquisa e navegação:** J03/J04 com rastreabilidade, supervisão e
   recuperação; reaproveitar as costuras do Harness e as autoridades atuais.
5. **P2 — experiência multiplataforma:** medir instalação, uso e recuperação
   em cada SO e em aparelho móvel físico antes de escolher um invólucro nativo.
   Não prometer paridade desktop/mobile apenas por responsividade.
6. **P3 — comparação externa:** executar o protocolo, publicar limitações e
   priorizar diferenças observadas por impacto, esforço e risco. Só então
   formular uma conclusão restrita à jornada e à amostra medidas.

Direção visual preservada: identidade FRIGG, tema grafite aprovado, tarefa em
conversa, hierarquia clara, progresso em palavras, ações acessíveis em telas
baixas e no celular. Melhorias de layout devem partir de captura e medição;
não trocar essa direção por uma composição genérica de cards.
