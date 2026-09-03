# O que o seu protótipo já faz — e o que ainda não faz

O DZ23 STUDIO já consegue criar e conferir quatro tipos de protótipo:

- página de apresentação;
- catálogo;
- formulário que salva informações e mostra uma lista;
- painel interno para criar, editar e excluir cadastros.

Quando o protótipo guarda informação sensível, ou quando é um painel interno,
ele pede acesso por e-mail. O proprietário é o endereço configurado pelo dono
do aplicativo. Ele recebe um código de seis números e pode convidar membros da
equipe. Não existe senha padrão ou entrada escondida.

Durante a verificação local, o sistema usa um entregador de código próprio do
Studio. A tela Verificação mostra os códigos usados pela prova automática e
avisa que eles já foram consumidos. Esse modo é bloqueado em produção. Quando
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
