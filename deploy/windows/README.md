# DZ23 STUDIO no Windows 11

Suporte v1: Windows 11 com WSL2, projeto e dados em filesystem Linux `ext2`, `ext3` ou `ext4` (`stat -f` pode reportar `ext2/ext3` para ext4), sob `/home/...`, e Docker Desktop em modo de contêineres Linux. Os scripts não instalam WSL, Docker ou Git, não pedem privilégios administrativos e nunca instalam certificados, proxy TLS, MITM, TPROXY, drivers ou serviços do Windows.

## Antes de começar

1. Instale e configure PowerShell 7, WSL2 e Docker Desktop pelos canais oficiais.
2. Mantenha o checkout auditado limpo, saiba o SHA-1 completo do commit aprovado e materialize o submodule declarado em `.gitmodules`. O `UPSTREAM.lock`, o gitlink, a origem, o commit, a tree, o manifesto e a limpeza do submodule precisam coincidir.
3. Use somente as imagens do Studio e do Caddy DZ23 publicadas e fixadas por digest (`repositorio@sha256:...`). O instalador não compila nenhuma delas.
4. Crie o arquivo de segredos **dentro do ext4 do WSL2**, fora do checkout, com permissão `600`. Os scripts conferem a permissão, mas nunca imprimem nem copiam o conteúdo.

## Comandos

Execute em PowerShell comum, nunca como Administrador:

```powershell
./deploy/windows/install.ps1 -SourcePath C:\caminho\studio -ExpectedCommit <40-hex> -Image <studio@sha256:64-hex> -CaddyImage <caddy-dz23@sha256:64-hex> -Distro Ubuntu -InstallRoot /home/seu_usuario/.local/share/dz23-studio

./deploy/windows/install.ps1 -SourcePath C:\caminho\studio -ExpectedCommit <40-hex> -Image <studio@sha256:64-hex> -CaddyImage <caddy-dz23@sha256:64-hex> -SecretsFile /home/seu_usuario/.config/dz23-studio/secrets.env -Start

./deploy/windows/doctor.ps1 -ExpectedCommit <40-hex> -Image <studio@sha256:64-hex> -CaddyImage <caddy-dz23@sha256:64-hex> -SecretsFile /home/seu_usuario/.config/dz23-studio/secrets.env

./deploy/windows/update.ps1 -SourcePath C:\caminho\studio -ExpectedCommit <novo-40-hex> -Image <novo-studio@sha256:64-hex> -CaddyImage <caddy-dz23@sha256:64-hex> -SecretsFile /home/seu_usuario/.config/dz23-studio/secrets.env

./deploy/windows/uninstall.ps1

./deploy/windows/uninstall.ps1 -PurgeData -PurgeConfirmation 'APAGAR DADOS DO DZ23 STUDIO'

./deploy/windows/Get-Dz23TrustStoreSnapshot.ps1 -Distro Ubuntu -OutputPath C:\evidencias\trust-before.json

./deploy/windows/Get-Dz23TrustStoreSnapshot.ps1 -Distro Ubuntu -OutputPath C:\evidencias\trust-after.json

./deploy/windows/Compare-Dz23TrustStoreSnapshot.ps1 -BeforePath C:\evidencias\trust-before.json -AfterPath C:\evidencias\trust-after.json -ReportPath C:\evidencias\trust-diff.json
```

Quando `-InstallRoot` não é informado, os scripts descobrem a pasta pessoal do usuário da distribuição WSL2 e usam `.local/share/dz23-studio`; não presumem que exista um usuário chamado `dz23`. `-SourcePath` continua sendo validado pelo Git do Windows e depois é convertido explicitamente por `wslpath -a` dentro da distribuição escolhida. O caminho Linux resultante precisa existir, ser um diretório real e é novamente validado pelo Git no Bash; caminhos com espaços ou Unicode não são remontados por concatenação textual.

A instalação cria uma identidade aleatória imutável e a grava nos recursos Docker. Antes de iniciar ou substituir qualquer runtime, o instalador inventaria contêineres, volumes e a rede tanto pelos rótulos do Compose quanto pelos nomes físicos reservados; falha na consulta ou recurso homônimo sem a mesma identidade interrompe a operação antes do `compose up`. Depois da subida, todos os serviços obrigatórios precisam estar `healthy`; a borda valida o certificado TLS usando o hostname público, e os volumes e a rede esperados precisam existir com a mesma identidade. A desinstalação cruza rótulos e nomes físicos antes de qualquer remoção, remove a rede do runtime e só apaga volumes quando `-PurgeData` é confirmado.

Por padrão, a desinstalação preserva volumes de dados, releases, estado e o arquivo de segredos. Ela remove somente os ponteiros operacionais `current` e `state/installed-commit`, depois de validar que ambos concordam; isso permite reinstalar uma release preservada sem confundir uma instalação parada com uma instalação ativa. A exclusão de dados exige **obrigatoriamente as duas opções** `-PurgeData` e `-PurgeConfirmation 'APAGAR DADOS DO DZ23 STUDIO'`. O prompt interativo adicional do PowerShell pode ser suprimido explicitamente com `-Confirm:$false`, mas isso não elimina nem altera a frase obrigatória. No purge, somente volumes rotulados como pertencentes ao projeto `dz23-studio`, releases e estado são removidos; a distribuição WSL, Docker Desktop, imagens compartilhadas e o arquivo de segredos não são removidos.

Use `-WhatIf` em instalação, atualização ou desinstalação para validar pré-requisitos e ver o plano sem alterar arquivos ou contêineres. Instalação e atualização iniciadas usam `docker compose up --no-build --wait` e validam imagem, commit, hash do Compose, identidade da instalação, estado e saúde de cada serviço. Uma trava impede operações concorrentes; um journal atômico permite que a próxima instalação/atualização conclua ou reverta uma operação interrompida. O diagnóstico e a remoção recusam operar enquanto houver journal pendente. Antes do start, `docker compose config --images` precisa mostrar somente imagens fixadas por digest completo. Nenhum Dockerfile do checkout é construído silenciosamente. Se uma atualização falhar, o script só declara rollback concluído quando a versão anterior também passar pelo gate de imagens, por `--wait` e pela validação de readiness; caso contrário, informa falha de rollback e exige intervenção manual.

Se o Compose do artefato ainda declarar um serviço apenas com `build:` ou uma imagem sem digest, o gate falha de propósito. Publicar e registrar por digest essa imagem é integração posterior M6.1; até isso acontecer, esse artefato não deve ser descrito como instalável em uma máquina nova.

Os snapshots acima leem quatro stores do Windows (`CurrentUser/Root`, `CurrentUser/CA`, `LocalMachine/Root` e `LocalMachine/CA`) e as três raízes de certificados da distribuição WSL2. A comparação ignora somente horário e informações do host; qualquer certificado, arquivo ou link acrescentado, removido ou alterado produz `CHANGED` e código de saída 3. Os coletores não instalam, removem ou atualizam certificados e nunca sobrescrevem uma evidência anterior.

## Executor da prova real M77

`Invoke-Dz23LifecycleProof.ps1` prepara e, somente com confirmação literal,
executa a sequência completa em um ambiente descartável: instalação saudável,
diagnóstico, sentinela PostgreSQL, atualização saudável, atualização que deve
falhar com rollback comprovado, desinstalação preservando dados, reinstalação,
verificação do sentinela e desinstalação final preservando dados. O trust store
é fotografado antes e depois.

Sem `-Execute`, o comando devolve `PREPARED_NOT_EXECUTED`: não consulta Docker,
não cria pasta e não altera o host. A execução exige Docker Desktop já iniciado
externamente; o runner nunca inicia o Docker, nunca aceita uma instalação
existente e nunca chama `-PurgeData`.

O gancho interno usado pelos testes nunca pode produzir prova real: seu
relatório recebe `SIMULATED_PASS`, `SIMULATED_NO_REAL_STATE_CHANGE` e
`source_and_images=PARTIAL_OR_NOT_VERIFIED`. Somente a execução sem esse gancho
pode terminar em `PASS`.

São necessários três checkouts limpos em commits distintos e três imagens
locais fixadas por digest: instalação, atualização saudável e imagem de falha
controlada. A última precisa existir localmente, mas falhar no readiness. O
ambiente deve estar sem contêineres, volumes ou redes DZ23.

```powershell
./deploy/windows/Invoke-Dz23LifecycleProof.ps1 `
  -InitialSourcePath C:\audit\initial -InitialCommit <40_hex> -InitialImage <image@sha256:...> `
  -UpgradeSourcePath C:\audit\upgrade -UpgradeCommit <40_hex> -UpgradeImage <image@sha256:...> `
  -FailureSourcePath C:\audit\failure -FailureCommit <40_hex> -FailureImage <imagem_inoperante@sha256:...> `
  -CaddyImage <caddy@sha256:...> -SecretsFile /home/usuario/.config/dz23/m77.env `
  -InstallRoot /home/usuario/.local/share/dz23-m77-proof `
  -EvidenceDirectory C:\evidencias\m77-AAAA-MM-DD `
  -Execute -ExecutionConfirmation 'EXECUTAR PROVA REAL M77 EM AMBIENTE DESCARTAVEL' -Confirm:$false
```

Se uma fase falhar, a execução registra `FAILED`, para e preserva o estado para
inspeção; não tenta limpeza automática. Sucesso termina em
`UNINSTALLED_DATA_PRESERVED`, deixando releases e volumes para conferência ou
remoção manual posterior. Enquanto não for executado com imagens auditadas, o
estado permanece `NOT_EXECUTED`.

## Gate de evidência de release M78

Depois de uma execução **real** do M77, valide o diretório sem iniciar Docker,
WSL2, rede ou qualquer serviço:

```powershell
./deploy/windows/Test-Dz23LifecycleEvidence.ps1 `
  -ReportPath C:\evidencias\m77-real\lifecycle-report.json `
  -EvidenceDirectory C:\evidencias\m77-real `
  -ExpectedInitialCommit <sha-inicial-de-40-caracteres> `
  -ExpectedUpgradeCommit <sha-atualizacao-de-40-caracteres> `
  -ExpectedFailureCommit <sha-falha-controlada-de-40-caracteres>
```

O único resultado de sucesso é `DZ23_M78_RELEASE_EVIDENCE=PASS`. O gate recusa
simulação, fase ausente ou duplicada, hash divergente, caminho fora do
diretório, arquivo ou link não regular, comparação inconsistente e qualquer
alteração independente entre os snapshots do trust store.

## Limites comprovados

- Scripts e testes em sandbox com PowerShell e Bash reais e Docker falso: implementados.
- Gate `UPSTREAM.lock`/submodule: implementado para a origem materializada e repetido sobre a declaração Git de cada release.
- Execução real em Windows 11 + WSL2 + Docker Desktop: `NOT_EXECUTED`.
- Imagem multi-arquitetura publicada e assinada: `NOT_PRESENT`.
- Instalação offline: `NOT_IMPLEMENTED`.
- Windows nativo sem WSL2: `NOT_SUPPORTED` na v1.
- Celular físico, domínio público, ACME, SMTP e passkey física: fora do gate destes scripts.

Um release só pode ser chamado de instalável no Windows depois de: testes simulados verdes; imagem fixada e verificada por digest; `doctor.ps1` verde; instalação, atualização, rollback provocado, desinstalação preservando dados e reinstalação comprovados numa máquina descartável; e prova de que o trust store do Windows e do WSL2 não mudou.
