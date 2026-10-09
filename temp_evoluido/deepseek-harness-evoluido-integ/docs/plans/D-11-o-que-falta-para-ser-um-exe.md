# D-11 — O que falta para o DZ23 STUDIO ser um `.exe`

Data: 09/09/2026. Estado: **estudo**, não decisão executada.
Pergunta do Prado: *"o que falta para ele ser um .exe"*.

## Como ele é instalado hoje

Não é um `.exe`. É mais parecido com um **serviço** do que com um programa de
mesa:

1. `deploy/windows/preflight.ps1` confere WSL2 e Docker;
2. `deploy/windows/install.ps1` copia o repositório para dentro da distribuição
   WSL, confere o commit fixado do Harness (`Assert-Dz23Commit`) e o **digest**
   de cada imagem (`Assert-Dz23ImageDigest`), monta um diretório de release
   imutável e liga os contêineres;
3. a pessoa abre o navegador no endereço do Studio, que é uma PWA.

Ou seja: hoje o produto está **entre** os dois modelos que o Prado citou. O
DeepSeek Harness original é uma CLI instalada por gerenciador de pacote; o
Claude Desktop é um aplicativo de mesa assinado. O DZ23 STUDIO é uma aplicação
web em contêiner com um instalador em PowerShell.

Isso não é acidente: o digest fixado e o release imutável são o que permite
dizer *qual* versão está instalada e provar que ela não foi trocada. Qualquer
rota até o `.exe` que jogue isso fora troca uma garantia real por conveniência.

## As três rotas, e o que cada uma custa

### Rota A — instalador `.exe` por cima do que já existe (recomendada)

Um instalador (Inno Setup, WiX/MSI ou MSIX) que embrulha o que os scripts já
fazem: verifica WSL2 e Docker, oferece instalar o que faltar, executa o
`install.ps1`, cria atalho no menu Iniciar e registra a desinstalação em
"Aplicativos e Recursos" apontando para o `uninstall.ps1` que já existe.

**Ganha:** a pessoa clica duas vezes e responde "avançar". Nenhuma linha de
comando. **Não ganha:** continua exigindo WSL2 e Docker na máquina.

### Rota B — aplicativo de mesa (Tauri ou Electron)

Uma janela nativa que embute a interface e cuida do backend. Hoje **não existe
nenhum Electron ou Tauri na árvore** — não é adaptar, é construir.

**Ganha:** parece com o Claude Desktop, tem ícone, janela e bandeja. **Não
ganha:** a janela é uma casca; o backend continua tendo que rodar em algum
lugar. Sem a rota A embaixo, ela só esconde o problema.

### Rota C — `.exe` autocontido, sem Docker

Empacotar Node, Postgres e a aplicação num binário só.

**Custa o que o produto tem de mais caro:** o `IMAGE_LOCK` e o digest fixado
deixam de significar alguma coisa, porque a reprodutibilidade passa a depender
do empacotador em vez do runtime de contêiner. Descartada por enquanto — a
troca é ruim.

**DECISÃO ASSUMIDA: Rota A** — instalador `.exe` sobre a arquitetura atual,
com a Rota B possível depois por cima dela, sem retrabalho. Justificativa: é a
única que dá o duplo-clique sem desmontar a cadeia de prova que já está pronta e
testada.

## O que falta, item por item

### 1. A imagem OCI publicada — `D-10`, `FAILED`

Bloqueio de primeira ordem: **um instalador precisa de algo para instalar.**
Hoje o `install.ps1` recebe `-Image <digest>` e exige que a imagem exista. Ela
nunca foi construída até o fim, e o motivo está registrado no ledger: os
contêineres deste ambiente não têm rota para os registros de pacote, e fazer a
construção passar exigiria injetar CA e interceptar TLS — proibido pelo
prompt-mestre, e eu não dobro regra de segurança para conseguir um verde.

Falta também, pelo mesmo bloqueio: buildx multi-arquitetura, o SBOM que
`release-provenance.mjs` já sabe validar mas ninguém gera, e o `docker run` de
fumaça.

**Depende de:** uma máquina com egresso de pacote para contêiner. **Não depende
de mim.**

### 2. Certificado de assinatura de código — decisão do Prado

Um `.exe` não assinado dispara o SmartScreen do Windows com "aplicativo não
reconhecido". Para quem não programa — que é o público deste produto — essa
tela **é** a instalação falhando.

Assinar exige um certificado de assinatura de código emitido para a pessoa
jurídica (LEANDRO MARCOS PRADO LTDA já existe, então o requisito de identidade
está resolvido). Tem **custo financeiro anual** e, no caso do certificado EV,
chega em token físico ou HSM.

**Isto é decisão sua, Prado:** tem custo e depende de documento que só você tem.
É o único item desta lista que eu não posso decidir sozinho.

### 3. O instalador em si — trabalho de engenharia, sem bloqueio

Não existe nenhum artefato de instalador no repositório. Falta escrever o script
do instalador, ligar o `uninstall.ps1` ao registro de desinstalação do Windows,
e produzir o `.exe` num passo de CI — e aqui há uma facilidade: o
`verify.yml` **já tem um job `windows-contracts` rodando em `windows-2025`**, que
é exatamente onde esse passo mora.

### 4. Canal de atualização assinado

`update.ps1` existe e sabe trocar de release. O que não existe é o **feed**: um
lugar onde o instalador pergunta "tem versão nova?" e verifica a assinatura da
resposta. Sem isso, cada atualização é um download manual — e um canal de
atualização não assinado é um vetor de ataque, não uma comodidade.

### 5. Prova de instalação limpa numa máquina limpa

`Invoke-Dz23LifecycleProof.ps1` e `Test-Dz23LifecycleEvidence.ps1` já provam o
ciclo de vida. Nenhum deles prova o que importa aqui: **uma pessoa que nunca
instalou nada, numa máquina onde WSL2 talvez nem esteja ligado, chega até a
primeira tela.** Enquanto essa prova não existir, "instalador pronto" é opinião.

## Resumo honesto

| # | Falta | Quem destrava |
|---|---|---|
| 1 | Imagem OCI construída, multi-arquitetura, com SBOM e smoke (`D-10`) | ambiente com egresso de pacote |
| 2 | Certificado de assinatura de código | **Prado** (custo + documento) |
| 3 | O instalador `.exe` e o passo de CI que o produz | engenharia, sem bloqueio |
| 4 | Feed de atualização assinado | depende de 1 e 2 |
| 5 | Prova de instalação limpa em máquina limpa | depende de 1 e 3 |

Nenhum desses itens é impossível. Mas **três dos cinco dependem da imagem, e a
imagem depende de uma máquina que este ambiente não é.** Por isso "falta pouco"
seria mentira: falta uma etapa que não é código.
