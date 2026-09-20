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
