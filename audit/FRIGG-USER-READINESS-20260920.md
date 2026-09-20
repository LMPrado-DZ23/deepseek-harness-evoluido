# Retomada da meta de usuário final — 20/09/2026

**Estado: EXECUTING, não finalizado.** O PR #1 é um checkpoint. A entrega
anterior não comprovava instalação e operação completas para o usuário final.
Base canônica `integ` reconfirmada: `997fa20d897a95061db6da17981c0713dce5f8a3`.
As alterações anteriores continuam preservadas no PR.

## Correções reproduzidas

1. **Partida silenciosa em pastas reais:** copiar os comandos para uma pasta
   `Leandro Prado` fazia `studio-start --conferir` sair com código 0, sem
   nenhuma saída nem execução. Comparar `import.meta.url` a `file://` mais o
   caminho não codifica espaços, acentos, `#` e `%` nem caminhos Windows.
   `pathToFileURL` corrige a partida, a borda e os três comandos de diagnóstico/
   provisionamento. Testes executam subprocessos reais nos três tipos de nome;
   autotestes dos provisionadores não equivalem a instalar Docker real.
2. **Endereço de produto errado:** o launcher real com Node 22.23.1 abriu a
   página `DeepSeek Harness`, com `Internal Testing Notice`. A interface FRIGG
   existe em `/studio/`. O launcher agora usa `--no-open` e apresenta o endereço
   FRIGG, preservando a admissão e a topologia da borda quando instalada.
   Leitura por linhas suporta anúncios divididos em vários chunks.
3. **Dois testes de restauração dependiam do checkout:** `safety.dump` relativo
   passava pela proteção dos ancestrais de `/workspace`, antes de alcançar a
   operação que o teste precisava medir. Os dois casos agora usam diretório
   temporário privado. As verificações de segurança do produto não mudaram.

## Evidências novas

- **Navegador completo:** 173 PASS, 3 SKIP, 0 FAIL, 422,9 segundos; sem builds
  simultâneos. Substitui a medição contaminada por build da auditoria anterior.
- **Gates:** 32/32 PASS; constituição PASS, após estas correções.
- **Node 22.23.1:** instalado nesta sessão sem modificar o pin nem o lockfile.
  O doctor real confirma pré-requisitos do Studio; aponta Docker/modelo ausentes.
- **Runtime real:** comando de produção, Harness original e perfil montado,
  sem o servidor fixture do E2E. Chromium recebeu HTTP 200, título FRIGG e o
  convite inicial correto. Também abriu projetos, ajuda, habilidades, plugins,
  agendado, biblioteca, empresas, objetivos e assistente. Isso prova navegação,
  **não** execução completa das funcionalidades dessas páginas.
- **Persistência real:** objetivo criado pela interface, preservado após recarga
  e após encerrar/reiniciar o processo FRIGG. Reinício do computador não foi
  executado; não extrapolar esta prova para todo estado do produto.
- **Regressões do launcher:** quatro testes em subprocessos; caminho normal,
  espaços, acentos/caracteres especiais e anúncio dividido em chunks.
- **Mutação:** retirar conversão de URL, retirar `--no-open` e voltar à raiz
  técnica fez os testes falharem; a conversão também foi retirada dos outros quatro
  comandos: 7/7 detectadas. Fontes restaurados depois.
- **Restauração/launcher/borda/provisionadores:** 108 testes aprovados em cinco
  arquivos; mais quatro testes de CLI em subprocessos reais.
- [Captura da abertura real](evidence/20260920/runtime-real-home.png), sem
  credenciais ou dados de clientes.
- **Raiz no Node 22:** 4.437 PASS, 175 FAIL, 68 SKIP. Continua FAILED.
  Não interpretar a troca de runtime como certificação da suíte.

## Triagem das falhas

Na rodada anterior, **98** falhas traziam `listen EPERM` diretamente no log;
esta é a contagem conferida, corrigindo a estimativa de 108 da atualização oral.
Há também duas falhas de montagem negada. Provisionamento, registro e estado
recusam overlayfs: suas guardas aceitam ext4/XFS. Os testes dependentes dessas
operações exigem reexecução num filesystem suportado; não foram afrouxados.
Nem toda falha em cascata foi individualmente provada como ambiental.

Com Node 22, três novas falhas estritas de stderr coincidem com a mensagem
`UNDICI-EHPA` emitida pela configuração de proxy deste ambiente. Ela afeta
expectativas de filho silencioso; não removemos configuração de rede nem
suprimimos warnings para fabricar aprovação. Um caso de volume também falhou
na rodada ampla e passou na reexecução focada: 49 PASS, 1 SKIP. A diferença
sob carga permanece `NEEDS_REVALIDATION`, sem aumento arbitrário de timeout.

## Bloqueios reais e trabalho restante

- `BLOCKED_BY_EXTERNAL_DEPENDENCY`: Docker e PostgreSQL não disponíveis;
  tentativa de instalação via apt recusada por restrições de identidade.
- `BLOCKED_BY_EXTERNAL_DEPENDENCY`: nenhum modelo configurado para a jornada
  nesta sessão; não foi consumido provedor pago nem usada credencial alheia.
- `BLOCKED_BY_EXTERNAL_DEPENDENCY`: conector local encontrou `DESKTOP-PRADO`
  offline. Ligar o computador e conectar o Desktop Commander permitirá tentar
  a validação na máquina do titular, após inventário e preservação do trabalho.
- CI do primeiro commit do PR falhou antes de executar etapas; causa específica
  não confirmada. Não foi declarada aprovação de CI.
- Continuam internas as lacunas registradas no DAG: adoção dos dados pessoais
  no primeiro registro, agendamento durável, clientes desktop/mobile e demais
  jornadas ainda sem aceite. Não foram convertidas em bloqueios externos.
- Ainda falta provar instalação limpa, tarefa com modelo e construtor reais,
  alteração, exportação/importação, retomada após reinício do computador e
  uso por pessoas leigas nas plataformas prometidas.

Não há base para chamar o produto de finalizado nem superior ao Manus.

## Continuação: integridade do plano

`AUDIT-PLAN-01` fecha duas falhas adicionais. Uma resposta lenta do planejador
podia sobrescrever edições, pedidos de mudança e até a aprovação já concluída.
Além disso, contar registros para numerar propostas fazia uma proposta nova
receber revisão inferior à do plano editado e desaparecer da leitura corrente.

As gravações agora são serializadas por escopo/projeto nesta instância. O modelo
responde fora da trava: a pessoa continua podendo editar e aprovar. Antes da
gravação, identidade, revisão e estado são relidos; resposta desatualizada vira
conflito com orientação para recarregar. Plano indisponível é recusado antes de
chamar o modelo. Novas propostas avançam a maior revisão existente.

Evidência: sete regressões falham no código anterior; 179 testes de serviço,
edição, reenvio existente, leitura, revisão e HTTP passam. Cinco mutações
(remover serialização, revisão atual, estado atual, recusa antes do modelo e
numeração monotônica) são detectadas. Typecheck e build do pacote passam.
Isso não prova CAS entre processos, idempotência durável de `plan/edit` e
`plan/slice`, nem integração com modelo real.

A CI do checkpoint f554fb3 também falhou antes de executar etapas: run
35515702641, jobs Linux e Windows sem runner atribuído. Não foi possível obter
a causa específica pelo endpoint de checks; não há declaração de CI verde.

Após recompilar o pacote alterado, as 13 jornadas de `journey.spec.ts` passaram
no Chromium (28,3 s). Usam o servidor de teste e não certificam modelo real.

A rodada focada também passou com Node 22.23.1 (179 testes). Os 32 portões
e a constituição passaram após as correções. Evidência estruturada em
[evidência do plano](evidence/20260920/plan-verification.json).

## Continuação: reenvio durável e preservação do rascunho

`AUDIT-REPLAY-01` resolve a pendência de `plan/edit` e `plan/slice` citada no
checkpoint anterior. As duas rotas aceitam chave de intenção; o cliente mantém
a mesma chave na repetição do mesmo pedido. Cada edição ou etapa produz um
registro de revisão preservado, cujo identificador vem da reserva durável.
Reenviar recupera essa revisão, mesmo após edições posteriores. O escopo e a
autorização são reconferidos. A trilha de edição tem identidade determinística,
permitindo reparar uma queda entre gravação e auditoria sem duplicar a trilha;
a data permanece a da edição, mesmo após aprovação posterior.

A tela agora distingue sucesso de falha: o editor e o texto de etapa não são
limpos quando a resposta se perde. A falha de atualização dos detalhes aparece
na interface; o resultado de uma escrita já confirmada continua reconhecido.

`pnpm prove:plan-replay` usa o backend JSON e os domínios do Harness, com o
repositório do produto, em dois processos independentes. O segundo recupera
edição e etapa sem mudar a revisão atual nem aumentar o contador do modelo.
Uma tentativa com resposta incerta permanece recusada ao reabrir. Modelo
controlado nesta prova; nenhum provedor real nem cobrança foi exercitado.

Sem CAS distribuído: dois processos concorrentes não são certificados por
esta prova de reinício sequencial. Chamadas externas sem resultado confirmado
não são repetidas automaticamente. A mensagem pede que a pessoa confira o
plano e formule nova intenção caso a etapa continue ausente.

Compatibilidade: registros antigos continuam aceitos; novos recibos usam dois
valores adicionais do enum existente, sem destruir ou migrar registros antigos.
Um binário anterior não reconhece esses valores. **Rollback exige backup
consistente de todo o armazenamento anterior ao uso**, não exclusão avulsa dos
recibos. Nenhum armazenamento de produção foi alterado nesta sessão.

## Primeiro cadastro: projetos e arquivos pessoais

`ABRIR-03` conserva os identificadores do principal pessoal no primeiro cadastro
local verificado. Nao move tabelas nem arquivos. Convite conserva seu proprio
escopo; codigo de outro modo/escopo e recusado e auditado. 188 testes e seis
mutacoes sustentam as guardas. `prove:personal-adoption` usa JSON real e dois
processos, servicos reais de identidade/tenancy/projetos e resolucao real da
pasta do assistente; os adaptadores de tabela montados pela prova persistem nos
dominios do Harness. OTP verificado pelo servico, email capturado em memoria.
Nao e prova de SMTP, navegador autenticado real ou reinicio do computador.
Nao migra instalacoes ja cadastradas; vinculos de conversas pessoais ainda
nao sao transferidos. A meta geral permanece aberta.

Limite adicional medido na revisao: a chave de envio da interface permanece em
`useRef`; fechar/recarregar a pagina antes da confirmacao perde essa identidade.
O servidor recupera recibos entre processos quando recebe a mesma chave; isto
nao prova uma caixa de saida duravel no navegador. Essa parte de V7-C continua
pendente, assim como CAS para escritores simultaneos em processos distintos.

## Verificacao conjunta de reenvios e primeiro cadastro

32 portoes e constituicao PASS; interface 1.075 PASS; identidade/tenancy 188
PASS; 13 mutacoes detectadas (sete reenvio, seis cadastro). Ambas as provas
JSON em dois processos passaram em Node 22.23.1 e 24.19.0.
Navegador completo em copia isolada: 174 PASS, 3 SKIP, zero falhas. A rodada
anterior no workspace teve 173 PASS/1 FAIL/3 SKIP porque a guarda da PWA viu
quatro bundles historicos. Fontes executaveis conferidas byte a byte; build
novo na copia isolada e a mesma guarda, sem afrouxamento, passaram. Causa de
reaparecimento dos artefatos no workspace nao identificada; nao e certificado
que qualquer pasta de build esteja limpa.
Raiz em Node 22: 4.459 PASS/174 FAIL/68 SKIP, mesmos nomes de falha da rodada
anterior. PostgreSQL novamente NOT_EXECUTED, sem Docker/servidor. Nenhuma
protecao de runtime, sistema de arquivos ou proxy foi desligada.
Evidencia consolidada: `audit/evidence/20260920/replay-adoption-verification.json`.

## Recuperacao de provisionamento interrompido (ABRIR-03-R)

O cadastro salvava o usuario antes de criar seu espaco. Se a criacao falhasse,
o proximo login pulava o provisionamento. Marcador persistido agora diferencia
cadastro pendente de concluido; so o pendente repete a etapa, antes de emitir
sessao. Uma segunda falha ao gravar a conclusao tambem conserva a pendencia.
190 testes PASS e quatro mutacoes detectadas. A variante
`prove:personal-adoption:recovery` injeta falha na escrita do espaco apos gravar
usuario/organizacao/membership, encerra o processo, retoma e reabre novamente.
O projeto e o arquivo continuam acessiveis, com recusa do escopo alheio.
Email local capturado; sem SMTP nem computador do titular. Registros antigos
sao aceitos. Binario antigo recusa o novo campo quando ainda pendente; rollback
exige concluir ou restaurar backup consistente, nao apagar o marcador.

Verificacao da recuperacao: 32 portoes e constituicao PASS; 190 testes focados,
1.075 testes da interface e 174 testes de navegador PASS (3 SKIP). Raiz Node 22:
4.461 PASS/174 FAIL/68 SKIP, sem novos nomes de falha. Banco novamente
NOT_EXECUTED. A prova em tres processos tambem passou em Node 22.23.1.
Evidencias: `audit/evidence/20260920/provision-recovery-verification.json`.
CI do checkpoint d7de66c: run 35520291793, ambos jobs falharam sem etapas.


## 20/09 — reenvio de edicao e etapa no navegador

AUDIT-CLIENT-REPLAY-01 validado localmente: IndexedDB confirma metadados antes do POST, conserva chave/revisao entre abas e limpa no logout. 9 mutacoes detectadas; 32 portoes PASS; 1.095 testes de interface; navegador 174 PASS/3 SKIP. Raiz segue com 174 falhas preexistentes. Outros envios, CAS distribuido, instalacao real e CI permanecem abertos. Evidencia: `audit/evidence/20260920/client-replay-verification.json`.


## 20/09 — pedido antigo de alteracao

AUDIT-CHANGE-REPLAY-01: duas regressoes demonstraram reenvio alterando proposta posterior. Resultado passa a ter versao preservada ligada ao recibo; reserva sem resultado falha sem reaplicar. 1.409 testes do plugin, quatro mutacoes, JSON real em dois processos e 32 portoes passaram. Raiz: 4.467 PASS/174 FAIL/68 SKIP, sem falhas novas. Recibos legados sem vinculo nao sao migrados por suposicao. Cliente dessa rota e CAS seguem pendentes. Evidencia: `audit/evidence/20260920/plan-change-replay-verification.json`.


## 20/09 — consumo incerto no questionario

AUDIT-INTAKE-REPLAY-01: sete regressoes cobrem resultado externo perdido, falha de escrita e recibo legado sem result_id. Questionario, mudanca e etapa recusam repeticao incerta. 1.418 testes do plugin, cinco mutacoes, JSON reaberto e 32 portoes passaram. Raiz: 4.476 PASS/174 FAIL/68 SKIP, sem novas falhas. Sintese posterior, agrupamento das inferencias e persistencia do cliente continuam pendentes. Evidencia: `audit/evidence/20260920/intake-replay-verification.json`.


## 20/09 — recuperacao da revisao

AUDIT-REVISION-RECOVERY-01: marcador duravel permite retomar estado e trilha depois de salvar especificacao. Serializacao protege contra outra revisao, arquivamento e desfazer. Historico parcial avanca a maior versao. 1.429 testes, oito mutacoes, JSON real e 32 portoes passaram. Raiz: 4.487 PASS/174 FAIL/68 SKIP, sem falhas novas. Cliente da revisao, CAS e instalacao real permanecem pendentes. Evidencia: `audit/evidence/20260920/revision-recovery-verification.json`.


## 20/09 — criacao persistente no navegador

AUDIT-CREATE-CLIENT-01: mesma intencao recupera a tarefa apos fechar a aba; bloqueio de armazenamento impede POST; confirmacao permite nova tarefa. Interface 1.100 PASS; navegador 175 PASS/3 SKIP/0 FAIL; quatro mutacoes e 32 portoes PASS. Guarda da Biblioteca passa a contar por URL e detectou o laco reintroduzido. PWA preservou guarda de bundle unico e passou em copia nova. Design/logo, demais envios e instalacao real seguem pendentes. Evidencia: `audit/evidence/20260920/creation-client-verification.json`.
