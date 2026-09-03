DZ23 STUDIO — FASE 0.5

Este pacote não contém o OmniSeek. Informe ao lançador o checkout P40 separado,
limpo e no commit d9a8109528839a9f6c691cab9d71f3fce7e91e02.

Pré-requisitos do facilitador:
- Windows com WSL2/Ubuntu;
- Python 3.12+ dentro do WSL2;
- Docker disponível dentro do WSL2;
- uma IA local rodando em localhost;
- dependências do checkout P40 já instaladas e auditadas.

O Docker executa somente a criação em sandbox do protótipo. O kit não instala
Docker, imagens, pacotes ou serviços.

Exemplo no PowerShell:

  .\Start-DZ23-Research.ps1 `
    -OmniSeekRoot "C:\caminho\para\p40-omniseek-hardening" `
    -ParticipantId P01

Antes da primeira sessão, acrescente -PreflightOnly. O comando valida tudo e
encerra sem criar dados nem abrir o servidor.

Se as dependências estiverem num ambiente virtual do WSL2, informe o Python:

  -WslPython "/caminho/do/venv/bin/python"

O lançador não instala dependências automaticamente. Essa recusa é intencional:
o P40 ainda não possui lock/SBOM aprovado para distribuição.

O lançador também não herda chaves, logins de CLIs ou endereços externos do
Windows/WSL2. Ele cria um ambiente mínimo e passa explicitamente apenas a IA
local detectada em localhost.

O facilitador faz login e só então entrega o notebook ao participante.
Para encerrar, volte ao terminal e pressione Ctrl+C.

Não use nome, e-mail ou documento no ParticipantId. Use somente P01 a P05.
