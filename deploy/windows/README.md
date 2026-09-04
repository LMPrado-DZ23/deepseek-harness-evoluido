# DZ23 STUDIO no Windows 11

Suporte v1: Windows 11 com WSL2, projeto e dados no disco Linux (`/home/...`) e Docker Desktop em modo de contêineres Linux. Os scripts não instalam WSL, Docker ou Git, não pedem privilégios administrativos e nunca instalam certificados, proxy TLS, MITM, TPROXY, drivers ou serviços do Windows.

## Antes de começar

1. Instale e configure PowerShell 7, WSL2 e Docker Desktop pelos canais oficiais.
2. Mantenha o checkout auditado limpo e saiba o SHA-1 completo do commit aprovado.
3. Use somente uma imagem fixada por digest (`repositorio@sha256:...`).
4. Crie o arquivo de segredos **dentro do ext4 do WSL2**, fora do checkout, com permissão `600`. Os scripts conferem a permissão, mas nunca imprimem nem copiam o conteúdo.

## Comandos

Execute em PowerShell comum, nunca como Administrador:

```powershell
./deploy/windows/install.ps1 -SourcePath C:\caminho\studio -ExpectedCommit <40-hex> -Image <imagem@sha256:64-hex> -Distro Ubuntu -InstallRoot /home/seu_usuario/.local/share/dz23-studio

./deploy/windows/install.ps1 -SourcePath C:\caminho\studio -ExpectedCommit <40-hex> -Image <imagem@sha256:64-hex> -SecretsFile /home/seu_usuario/.config/dz23-studio/secrets.env -Start

./deploy/windows/doctor.ps1 -ExpectedCommit <40-hex> -Image <imagem@sha256:64-hex> -SecretsFile /home/seu_usuario/.config/dz23-studio/secrets.env

./deploy/windows/update.ps1 -SourcePath C:\caminho\studio -ExpectedCommit <novo-40-hex> -Image <nova-imagem@sha256:64-hex> -SecretsFile /home/seu_usuario/.config/dz23-studio/secrets.env

./deploy/windows/uninstall.ps1 -SecretsFile /home/seu_usuario/.config/dz23-studio/secrets.env
```

Quando `-InstallRoot` não é informado, os scripts descobrem a pasta pessoal do usuário da distribuição WSL2 e usam `.local/share/dz23-studio`; não presumem que exista um usuário chamado `dz23`.

A desinstalação preserva volumes de dados e releases por padrão. A exclusão exige `-PurgeData`, confirmação interativa do PowerShell e a frase explícita documentada no próprio erro; nesse modo, remove os volumes exclusivos do projeto e os releases. Ela não remove a distribuição WSL, Docker Desktop, imagens compartilhadas ou o arquivo de segredos.

Use `-WhatIf` em instalação, atualização ou desinstalação para validar pré-requisitos e ver o plano sem alterar arquivos ou contêineres.

## Limites comprovados

- Scripts e testes simulados: implementados.
- Execução real em Windows 11 + WSL2 + Docker Desktop: `NOT_EXECUTED`.
- Imagem multi-arquitetura publicada e assinada: `NOT_PRESENT`.
- Instalação offline: `NOT_IMPLEMENTED`.
- Windows nativo sem WSL2: `NOT_SUPPORTED` na v1.
- Celular físico, domínio público, ACME, SMTP e passkey física: fora do gate destes scripts.

Um release só pode ser chamado de instalável no Windows depois de: testes simulados verdes; imagem fixada e verificada por digest; `doctor.ps1` verde; instalação, atualização, rollback provocado, desinstalação preservando dados e reinstalação comprovados numa máquina descartável; e prova de que o trust store do Windows e do WSL2 não mudou.
