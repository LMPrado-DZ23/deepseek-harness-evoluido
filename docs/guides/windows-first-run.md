# Primeiro acesso seguro no Windows

Este assistente prepara o arquivo de configuração inicial do DZ23 STUDIO sem
ligar o Docker, abrir portas ou mudar o Windows. Ele não instala programas, não
usa privilégios de administrador e não altera certificados, DNS, `hosts`,
firewall ou regras do Tailscale.

O suporte desta versão é **Windows 11 + PowerShell 7 + WSL2**. O arquivo é
criado dentro da pasta pessoal Linux da distribuição WSL2, nunca em `C:` ou
`/mnt/c`. O diretório fica com permissão `0700` e o arquivo com `0600`.

## O que você precisa decidir antes

1. O e-mail real da primeira pessoa proprietária. Só esse e-mail poderá fazer
   o primeiro cadastro.
2. Um serviço SMTP real, com servidor, porta, TLS implícito, usuário, senha e
   remetente. O Compose atual exige SMTP. O assistente não inventa senha, não
   usa um servidor de teste e não captura códigos em arquivo. `STARTTLS` é
   recusado nesta fatia: o consumidor de identidade ainda não possui uma opção
   `requireTLS` que prove a impossibilidade de downgrade. Use somente um
   endpoint de TLS implícito, normalmente na porta 465.
3. Um perfil de acesso:

   - `local`: funciona somente neste computador, em
     `http://studio.dz23.localhost:8080`, usando o Compose local. Não publique
     essa porta na internet.
   - `tailscale`: prepara os nomes HTTPS, mas **não** instala o Tailscale nem
     comprova identidade, ACL ou certificado. Esses itens continuam pendentes.
   - `public`: prepara um domínio HTTPS público, mas **não** configura DNS,
     firewall, portas ou ACME. Esses itens continuam pendentes.

O perfil local ainda não é selecionado automaticamente pelo `install.ps1`; ele
é usado com `deploy/caddy/docker-compose.local.yml`. Os perfis externo e
Tailscale só podem ser chamados de operacionais depois dos respectivos gates
de rede. Basic Auth nunca deve ser a única proteção de um acesso público.

## Uso interativo

Abra um PowerShell 7 comum, nunca como Administrador, e execute:

```powershell
./deploy/windows/New-Dz23Secrets.ps1
```

O assistente pergunta somente o que estiver faltando. A senha SMTP é digitada
de forma oculta. O caminho padrão é
`~/.config/dz23-studio/secrets.env` dentro da distribuição `Ubuntu`.
Em um HOME novo, o assistente cria somente `.config` e `dz23-studio`, ambos
como diretórios reais do usuário; `.config` novo e `dz23-studio` ficam em
`0700`. Um `-Destination` personalizado deve apontar para um diretório pai que
já exista, seja `0700` e esteja no ext2/ext3/ext4 — nenhuma cadeia arbitrária de
pastas é criada.

Para conferir tudo sem gerar nem gravar segredos, acrescente `-DryRun`. O
`DryRun` ainda exige os dados obrigatórios para provar que a futura configuração
é coerente.

## Uso não interativo

Passe dados públicos por parâmetros e a senha SMTP como `SecureString` ou pelo
stdin. Não coloque a senha na linha de comando, numa variável de ambiente ou
num arquivo versionado.

```powershell
$smtpPassword = Read-Host 'Senha SMTP' -AsSecureString
$config = @{
  Profile = 'public'
  Destination = $caminhoLinuxConfirmado
  BootstrapOwnerEmail = $emailDoProprietario
  Hostname = $dominioPublico
  AcmeEmail = $emailDeOperacao
  AcknowledgeExternalPrerequisites = $true
  SmtpConfigured = $true
  SmtpHost = $servidorSmtp
  SmtpPort = 465
  SmtpTlsMode = 'implicit-tls'
  SmtpUser = $usuarioSmtp
  SmtpPassword = $smtpPassword
  SmtpFrom = $remetenteSmtp
  NonInteractive = $true
}
./deploy/windows/New-Dz23Secrets.ps1 @config
```

Os nomes acima explicam o formato; use somente dados reais. Valores contendo
`example`, `fake`, `placeholder`, `test`, `invalid` ou equivalentes são
recusados.

Para automação, `-ReadSmtpPasswordFromStdin` lê uma única linha de um canal
redirecionado. O conteúdo nunca é colocado nos argumentos do `wsl.exe`. O
processo Linux começa com `env -i`, recebe os dados pelo stdin e gera os
segredos da borda e do PostgreSQL diretamente de `/dev/urandom`.

## Substituição segura

O destino existente é recusado por padrão. `-Overwrite` só funciona quando o
destino é arquivo regular, pertence ao usuário atual, tem um único hardlink e
modo `0600` ou `0400`. Antes da substituição atômica, uma cópia com nome único e
modo `0600` é criada no mesmo diretório e conferida contra a versão que estava
travada no início da operação.

Cada destino possui um lock exclusivo, atômico e `0700`. Duas instâncias
oficiais não gravam ao mesmo tempo. O assistente fotografa filesystem,
proprietário e identidade `device:inode` do diretório e do arquivo e revalida
esses dados depois do lock, antes do backup e imediatamente antes do `mv`.
Trocas detectadas fazem a operação falhar fechada. Um processo hostil já
executando com o mesmo UID Linux está fora deste modelo de ameaça: ele já pode
ler um segredo `0600`; ainda assim, as trocas observáveis são recusadas e um
lock que não seja o criado pela instância atual nunca é removido por ela.

Se o computador ou o WSL2 for encerrado à força exatamente durante a gravação,
o lock pode permanecer para impedir uma substituição incerta. Não apague a
pasta `.secrets.env.lock` manualmente sem antes confirmar que nenhuma execução
do assistente continua viva; a recuperação guiada desse caso será fechada com
o lifecycle completo do instalador.

Links simbólicos, hardlinks, objetos especiais, travessia `..`, diretório com
permissão diferente de `0700`, filesystem diferente de ext2/ext3/ext4 e todos
os caminhos `/mnt/*` são recusados. Junctions e reparse points do Windows não
entram no fluxo porque nenhum caminho Windows é aceito como destino.

## O resumo não contém segredos

Ao terminar, a tela mostra perfil, caminho, host, origem, RP ID e pendências.
Segredos aparecem somente como `[CONFIGURADO]` ou `[NAO_GERADO]`. A indicação
`SMTP=[CONFIGURADO_NAO_TESTADO]` significa que o formato foi validado, mas
nenhuma conexão de rede ou envio real foi feito.

Depois da criação, use o `doctor.ps1` e o gate da instalação correspondente.
Não chame o sistema de instalado ou acessível no celular apenas porque este
arquivo foi criado.
