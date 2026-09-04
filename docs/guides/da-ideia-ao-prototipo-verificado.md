# Da ideia ao protótipo verificado

O DZ23 STUDIO pede que você conte sua ideia com palavras comuns. Depois faz uma
pergunta por vez, mostra um plano e só começa a criação quando você aprova.

Durante a criação, o Studio trabalha dentro de um espaço isolado e sem internet.
Ele usa dependências preparadas anteriormente, compila o projeto, roda testes e
confere acessibilidade e sinais de segredos ou dados sensíveis. Se algo falhar,
ele tenta corrigir no máximo três vezes e mostra o problema real.

Ao final, “protótipo verificado” quer dizer apenas que as verificações técnicas
declaradas passaram naquele computador. O Studio gera sete categorias: página
de apresentação, catálogo, formulário+banco, painel CRUD, agenda interna,
dashboard e área autenticada mínima. Banco e login existem nas categorias que
precisam deles. Os critérios que ainda não têm prova automática aparecem como
`NOT_AUTOMATED`; isso nunca é contado como “passou”. O preview seguro pertence
ao M1 e ainda precisa ser unido a esta jornada. Não há publicação, domínio de
produção nem deploy.

A opção “Somente no meu computador” bloqueia qualquer rota externa. A opção
“Permitir IA configurada” mostra qual serviço receberá sua ideia e respostas.
Os arquivos do projeto continuam locais em ambos os modos.
