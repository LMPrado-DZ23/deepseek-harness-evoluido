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
