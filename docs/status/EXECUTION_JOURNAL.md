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
