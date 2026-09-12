# ADR-026 — Categoria de cadastro e lista

- Estado: Aceita
- Data: 2026-09-03
- Ressalva: implementada no bloco 5 da fatia 2

O identificador físico é `form-database` e aparece na interface pt-BR como
“cadastrar informações e vê-las em uma lista”. A pessoa não precisa conhecer
os termos entidade, repositório ou migração. `crud-panel`,
`saas-authenticated` e `dashboard` continuam categorias distintas, conforme o
golden set do Plano Mestre.

Para essa categoria, a AppSpec precisa declarar ao menos uma entidade de
banco. O Studio gera de forma determinística e protegida o Server Action e o
componente de formulário/lista de cada entidade. O modelo só compõe a tela
principal com esses componentes; ele não escreve banco, SQL, migração,
repositório nem a ação que grava dados.

O compilador de aceitação acrescenta uma prova Playwright por entidade:
preenche os campos, aciona “Salvar” e exige que um valor marcador apareça na
lista. A prova oficial usa SQLite em arquivo — não apenas memória — dentro do
construtor com rede `none`. O arquivo é criado pela aplicação gerada e os
arquivos determinísticos permanecem imutáveis durante build e testes.

Dados sensíveis continuam fail-closed. A AppSpec só é gerada depois da
confirmação no intake e o formulário recebe o acesso real do ADR-024. Sem
sessão e CSRF, nenhuma gravação ocorre. Referências obrigatórias entre
cadastros ainda são recusadas, porque um campo técnico de ID não seria uma
experiência aceitável para leigos.

No golden set, as três fixtures `form-database-*` são executáveis. A segunda
pede informações de saúde, exige login por código e prova que o formulário
sensível não aparece sem sessão.
