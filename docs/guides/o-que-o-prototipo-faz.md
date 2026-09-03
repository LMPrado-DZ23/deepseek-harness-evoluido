# O que o seu protótipo já faz — e o que ainda não faz

O DZ23 STUDIO já consegue criar e conferir quatro tipos de protótipo:

- página de apresentação;
- catálogo;
- formulário que salva informações e mostra a lista somente à equipe;
- painel interno para criar, editar e excluir cadastros.

Um formulário comum pode receber dados sem exigir cadastro, mas nenhum
visitante vê o que outras pessoas enviaram. A lista fica disponível somente
depois do acesso da equipe. Quando o protótipo guarda informação sensível, ou
quando é um painel interno, ele pede acesso também antes do envio. O
proprietário é o endereço configurado pelo dono do aplicativo. Ele recebe um
código de seis números e pode convidar membros da equipe. Não existe senha
padrão ou entrada escondida.

Durante a verificação local, o sistema usa um entregador de código próprio do
Studio. A tela Verificação mostra os códigos usados pela prova automática e
avisa que eles já foram consumidos. Esse modo só funciona com a flag interna
do verificador, mesmo quando o servidor está em modo de produção. Quando
o preview seguro for construído, um novo código utilizável aparecerá nessa
mesma tela para a pessoa testar.

O protótipo é construído e testado em um contêiner sem internet. Banco,
autenticação, permissões e cabeçalhos são escritos pelo Studio e não pela IA.
Cada critério informa “Passou”, “Falhou” ou “Não verificado automaticamente”.

Ainda não existe preview no navegador fora do ambiente de prova, publicação,
deploy, dashboard, agenda ou portal separado para cada cliente. Também não há
passkey no aplicativo gerado. Por isso, “protótipo verificado” não significa
“aplicativo pronto” nem “publicado”. A experiência ainda não foi validada com
as cinco pessoas leigas da fase 0.5.

Nota de desenvolvimento: versões antigas do domínio `studio_runs` não são
migradas nesta pré-release. Se um ambiente local de desenvolvimento acusar
`version-mismatch`, apague somente esse domínio de teste e gere novamente. A
partir daqui, toda mudança de versão de domínio exige migração ou nota de
transição explícita.
