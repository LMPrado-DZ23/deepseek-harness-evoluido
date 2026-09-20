# Diário de execução

Ação, resultado, evidência, decisão, próximo passo. Sem raciocínio longo: para
isso existem as ADRs.

## 2026-09-11 — abertura da missão Engineering OS

**Ação.** Descoberta antes de escrever, como manda §3. Estado do git, submódulos,
documentos existentes, baseline completo, mapeamento de 32 capacidades e
auditoria de funcionalidade falsa.

**Resultado.** Baseline verde: typecheck, build, 18/18 portões, 2766 testes na
raiz. A auditoria de placeholders encontrou **zero** TODO/FIXME/HACK/XXX reais
(os onze "TODO" do repositório são a palavra portuguesa), zero placeholder, zero
botão sem handler, zero `any`, zero teste abandonado.

**Decisão 1.** Não criar documentos nos caminhos que a missão sugere quando já
existe equivalente com outro nome — §135 e §136 proíbem duplicar fonte de
verdade. `docs/CAPABILITY_MATRIX.md` continua sendo a do produto; a do
Engineering OS nasceu ao lado, porque são perguntas diferentes.

**Decisão 2.** A distância até a missão é de **camadas cognitivas**, não de
infraestrutura. Spec, Context, Memory, Review, Learning e Code Intelligence não
existem em nenhuma forma. Fundação de execução e segurança é sólida.

**Achado que mudou o trabalho.** `hasApprovedAncestor` decidia autorização só
pela linhagem de sessões, sem conferir o worktree, exportada ao lado de
`approvedGrantFor`, que confere. Nenhuma das duas era chamada pela insegura — o
risco era o próximo leitor escolher pelo nome mais curto.

**Achado sobre o próprio método.** Investigando o `catch {}` do gerador de
e-mail, descobri que ele vive **dentro de um template que gera o código do
aplicativo do usuário**, não dentro do plugin. Meu primeiro teste importava uma
classe que não existe no módulo. O teste certo confere o TEXTO gerado, que é
como este repositório testa código gerado. O conserto vale para todo aplicativo
gerado com formulário.

**Evidência.** 5 tarefas P0 fechadas com 9 testes novos e 5 falsificações, todas
reprovando como deviam.

**Próximo passo.** T-06: `trace_id` correlacionando missão → tarefa → execução
de agente → chamada de ferramenta. É pré-requisito de medição para tudo que vem
depois.

## 2026-09-11 — meta-loop: revisão adversarial do próprio dia

**Ação.** Um revisor com contexto novo auditou o diff `af54d75..845c018`
tentando quebrá-lo. Regra: não confiar na autoavaliação de quem executou.

**Resultado.** Oito achados, nenhum CRITICAL. Cinco corrigidos pela causa raiz,
dois LOW fechados por decisão registrada, um LOW aberto com próximo passo.

**O achado que eu não veria de dentro.** `as const satisfies` é promessa de
compilação. A tabela de sandbox está exportada no índice público do pacote, e
uma linha num plugin montado no mesmo contexto desligaria a escalada
obrigatória para T3 do processo inteiro — sem nenhum teste ver. A comparação
literal que existia antes era imutável por construção; eu troquei clareza por
superfície nova e não paguei a conta. `Object.freeze` paga.

**O achado mais instrutivo.** O remetente de captura do Studio escrevia direto
no arquivo final — logo, era o **único capaz de produzir** o JSON truncado que
minha leitura conferida passou a recusar. O conserto de leitura teria criado um
beco onde antes havia auto-cura por sobrescrita. Consertar um lado sem olhar o
outro é como se conserta pela metade.

**O que o revisor fez e eu não tinha feito.** Rodou as duas versões do motor de
política lado a lado sobre a matriz completa de modo × tier × origem: 64
divergências, zero mais frouxas. E compilou o código gerado de verdade, com
`tsc --strict`, em vez de confiar na leitura.

**Próximo passo.** T-06 (`trace_id`) só começa com um produtor real: metade dele
— schema e resolver sem quem preencha — seria exatamente a API morta que
removi hoje de manhã.


## 2026-09-20 — auditoria independente Codex, base GitHub 997fa20

**Ação.** Confirmado o HEAD de `integ` pela API; ZIP conferido por SHA-256 e
6.167 blobs comparados com a árvore remota. Checkout shallow reconstruído com
OID exato; pin upstream preservado. Corrigidos digest não comparado no CLI,
perda em uploads concorrentes, caminhos de arquivos sujeitos a links e
compositor cortado em telas de 320/390 px. Launcher de gates/E2E passa pelo
loader Node, mantendo os mesmos scripts.

**Evidência.** Relatório `audit/FRIGG-AUDIT-20260920.md`, capturas antes/depois,
regressões reais de filesystem e CLI, quatro mutações detectadas. 32 gates,
build e testes focados aprovados; 173 falhas na suíte da raiz e PostgreSQL
não executado impedem declaração de aprovação global. O relatório concentra
os resultados finais e as limitações, inclusive navegador e Node diferente
do fixado para entrega.

**Decisão e próximo passo.** Entregar correções candidatas para revisão em PR
com destino `integ`; repetir CI e dependências reais antes de promover. O
protocolo `docs/plans/FRIGG-JOURNEY-BENCHMARKS.md` separa doze jornadas e onze
dimensões; comparação externa permanece `NOT_EXECUTED`. Não declarar vantagem
sobre Manus, paridade nativa nem auditoria de segurança exaustiva.


## 2026-09-20 — retomada: a meta é usuário final, não PR

Prado reafirmou que o objetivo ainda não foi cumprido. Corrigidos comandos
silenciosos em caminhos com espaços/acentos e o launcher que abria a interface
técnica. O runtime real com Node 22.23.1 abriu o FRIGG e nove destinos; E2E
completo 173 PASS/3 SKIP. Dois testes de restauração agora usam destinos
privados isolados, sem alterar as guardas. Raiz continua com falhas; Docker,
PostgreSQL real, modelo e computador do titular seguem bloqueando provas.
Estado e limites: `audit/FRIGG-USER-READINESS-20260920.md`. Missão permanece
EXECUTING; nenhum merge, release nem prontidão universal declarada.

## 2026-09-20 — AUDIT-PLAN-01, preservar decisões durante planejamento

**Ação.** Reproduzir sete cenários antes de corrigir: resposta tardia após
edição, aprovação ou pedido de mudança; duas edições; duas etapas concorrentes;
modelo chamado após aprovação; nova proposta após várias edições.

**Resultado.** Sete falhas na base e nenhuma após serializar gravações por
escopo/projeto, conferir o plano depois do modelo e incrementar a maior revisão.
179 testes integrados aprovados. Cinco retiradas intencionais das proteções
fizeram os testes falharem; fontes restaurados. Typecheck e build passaram.

**Limite.** Uma instância de serviço, sem transação/CAS distribuído. O modelo
é controlado nos testes. Reenvio durável das duas rotas não foi declarado pronto.
CI do commit anterior f554fb3 falhou sem etapas e sem runner atribuído
(run 35515702641); causa específica segue sem confirmação.

## 2026-09-20 — AUDIT-REPLAY-01, reenvios duráveis do plano

**Ação.** Cinco regressões iniciais reproduziram os reenvios sem recibo.
As revisões passaram a ter identificadores próprios e a reserva existente
passou a apontar para o resultado preservado. As rotas e a tela enviam a chave.

**Resultado.** A prova `scripts/prove-plan-replay.mjs` escreve e reabre os
mesmos domínios JSON do Harness em processos separados, usando o repositório
do produto. Recupera versões antigas sem alterar a atual, sem nova chamada de
modelo e sem duplicar a trilha. O modelo desta prova é controlado.
O navegador reproduziu descarte do rascunho após resposta perdida e silêncio
sobre leitura mal sucedida; ambos foram corrigidos. A auditoria também ganhou
prova de preservação da data da edição após aprovação posterior.

**Limites.** Uma instância escritora; sem garantia entre vários processos
concorrentes. Uma chamada externa cujo resultado não foi persistido fica
incerta e não é repetida automaticamente. Nova tentativa exige nova intenção.
Novos valores do enum de recibos são compatíveis com leitura dos registros
antigos, mas um binário anterior não os entende: rollback exige restaurar o
backup consistente anterior de todo o armazenamento, não apagar recibos.

## 2026-09-20 — primeiro cadastro preserva trabalho pessoal (ABRIR-03)

Prova inicial no JSON real reproduziu troca de usuario, org e tenant. O primeiro
cadastro local agora conserva os tres; convite mantem seu proprio escopo.
Codigo emitido antes de mudar o modo nao transfere autoridade. 188 testes
passaram; seis mutacoes foram detectadas. Projeto e arquivo continuaram
acessiveis apos cadastro e reabertura em outro processo, sem acesso ao tenant
alheio. SMTP capturado, sem entrega externa. Vinculos das conversas sinteticas
continuam em memoria; esta parte da continuidade segue aberta.

## 2026-09-20 — recuperacao do cadastro interrompido

A proxima falha foi reproduzida antes de corrigir: usuario persistia, espaco
falhava, novo login emitia sessao sem repetir a etapa que faltava. Marcador de
provisionamento pendente agora acompanha o usuario ate concluir. Falha ao gravar
a conclusao tambem impede sessao prematura. Matriculas completas nao repetem
a etapa. 190 testes PASS, quatro mutacoes detectadas, prova JSON real em tres
processos preservando trabalho e isolamento depois de falha de escrita.

## 2026-09-20 — intencao de envio sobrevive a fechar a aba

O teste novo reproduziu chave e revisao diferentes ao reabrir a aba depois de
perder a resposta. IndexedDB agora conserva apenas hashes, chave e revisao para
edicao/etapa. Transacao confirma antes do POST; nao ha texto nem fila automatica.
Navegador prova reabertura, duas abas, escopos, outra intencao, ACK antigo,
recibo corrompido, bloqueio do armazenamento e limpeza seletiva no logout.
Nove mutacoes foram detectadas depois de compilar cada candidata. As fontes
foram restauradas; 32 portoes PASS, interface 1.095 PASS, navegador 174 PASS/3 SKIP.
Raiz: 4.461 PASS/174 FAIL/68 SKIP, sem falhas novas. Outros envios ainda usam memoria.


## 2026-09-20 — pedido antigo nao deve alterar proposta nova

Duas regressoes demonstraram reaplicacao indevida apos reiniciar o servico ou
perder o resultado. O recibo agora identifica outra versao preservada. Uma
reserva sem resultado nao escolhe o plano corrente por suposicao. Recibos
legados sem vinculo falham com orientacao para conferir o plano. 1.409 testes
do plugin e prova JSON real em processos separados passaram; 32 portoes PASS; quatro mutacoes detectadas.


## 2026-09-20 — consumo incerto no questionario

Quatro regressoes demonstraram nova chamada de modelo apos falha externa ou
falha de escrita, com recomendacao e com resposta digitada. Reserva sem turno
agora recusa repeticao; resposta completa e relida, nova intencao explicita
continua possivel. 1.418 testes passaram. Sintese e inferencias posteriores
ao fazem parte desta garantia. 32 portoes PASS; raiz Node 22: 4.476 PASS/174 FAIL/68 SKIP, sem falhas novas.

Tres regressoes adicionais provaram que reserva legada sem result_id ignorava
a politica de incerteza no questionario, mudanca e etapa. A correcao cobre
tambem esse formato; cinco mutacoes validas foram detectadas. A tentativa
inicial da quinta mutacao atingiu outra funcao e foi excluida, depois refeita
no alvo correto. A prova JSON inclui recibo legado sem identificador.


## 2026-09-20 — criacao recuperavel no cliente

O navegador demonstrou nova chave depois de fechar a aba com resposta perdida.
A criacao passa a usar a mesma transacao de metadados, antes do POST. Recibo
de criacao usa revisao null e nao pode ser confundido com recibo de plano.
Um teste que lia strings do antigo useRef foi substituido pela jornada real
de envio, reabertura, recuperacao e nova tarefa depois da confirmacao.
Interface 1.100 PASS; navegador 175 PASS/3 SKIP/0 FAIL em copia nova; quatro
mutacoes e 32 portoes PASS. Design/logo continuam como passos separados.
Primeira rodada acusou teto fixo de leituras na Biblioteca; passou a exigir
uma leitura por endereco. Reintroduzir o laco fez a nova guarda reprovar.
Segunda rodada acusou dois bundles no diretorio reutilizado apos mutacao.
Copia nova compilada uma vez passou na guarda PWA sem altera-la.


## 2026-09-20 — revisao interrompida

Reproduzidos estado antigo apos salvar especificacao, trilha ausente apos
transicao e numero de versao menor que o atual em historico parcial. Marcador
no projeto antecede a especificacao; estado, trilha deterministica e limpeza
sao retomados na ordem. Outra mutacao nao ultrapassa a escrita pendente.
Oito mutacoes detectadas: remover mutex sobreviveu ao teste inicial; uma
barreira na primeira escrita tornou a corrida deterministica e detectou a
mutacao. 1.429 testes, 32 portoes e JSON real com tres pontos de falha passaram.
Raiz: 4.487 PASS/174 FAIL/68 SKIP, sem falhas novas. Cliente ainda em memoria.
