# ADR-026 — Categoria de cadastro e lista

Status: aceita e implementada no bloco 5 da fatia 2.

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

Dados sensíveis continuam fail-closed. Enquanto a autenticação gerada do
bloco 6 não existir, uma AppSpec sensível recebe
`AUTH_REQUIRED_FOR_SENSITIVE_FORM` em linguagem comum e não chega ao modelo.
Referências obrigatórias entre cadastros também aguardam o painel CRUD, porque
um campo técnico de ID não seria uma experiência aceitável para leigos.

No golden set, `form-database-01` e `form-database-03` são executáveis.
`form-database-02` permanece `NOT_IMPLEMENTED`, pois pede informações de saúde
e só poderá ser promovido com login real e a prova adversarial do bloco 6.
