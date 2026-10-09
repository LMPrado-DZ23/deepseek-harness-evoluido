# PoC-03 — OmniRoute 3.8.51 em contêiner descartável

- Resultado: **NO-GO para dependência da v1.0; integração rebaixada pela E2**
- Data da reexecução: 2026-09-02
- Snapshot: `OmniRoute-release-v3.8.51`
- Origem comprovada: `https://github.com/diegosouzapw/OmniRoute.git`
- Commit comprovado no P37: `d920e6495a53993b916f5b4948dcc583a0cbf208`
- PoC-01b aprovado preservado: `227948723c7121e88bdcf3fb1ca5a56a7c7fa6f8`

## Regra corrigida

A E1 proíbe o Studio de instalar ou ativar CA, alterar `hosts`, DNS, proxy ou firewall, ocupar a porta 443, habilitar Agent Bridge/MITM/TPROXY ou empacotar esses componentes no artefato do Studio. Ela não exige que os módulos estejam ausentes do binário externo do OmniRoute.

Por isso, a presença e a compilação desses módulos foram aceitas somente dentro de um contêiner descartável. O runtime não recebeu privilégio nem acesso ao trust store do host.

## Construção exata

Não existe manifesto oficial para `diegosouzapw/omniroute:3.8.51`, `:v3.8.51` ou `:release-v3.8.51`; usar `latest` não provaria o snapshot fixado.

O snapshot foi copiado para ext4 e conferido antes da build:

- 13.114 arquivos;
- versão `3.8.51`;
- `package.json`: SHA-256 `baa5eb182887b2ee56ac6e21051cbf72db397704fee29564a4ca712fff55af21`;
- `Dockerfile`: SHA-256 `78018c492de74d77de069fb3e4cca1ea6a47cfc98b0c262406046e9307bd1625`;
- `package-lock.json`: SHA-256 `31f59db0a87dcb7eddee3553cf9ded585f3968eb55d97e57381a521a8b25d86f`.

A build padrão com Turbopack falhou ao coletar `/api/provider-nodes/validate` porque `tiktoken_bg.wasm` não foi encontrado. A opção documentada pelo próprio Dockerfile, `OMNIROUTE_USE_TURBOPACK=0`, construiu a variante Webpack sem alterar código upstream.

Imagem local produzida:

- tag: `omniroute-poc03:3.8.51`;
- digest/ID: `sha256:77caedd6dc8b008bf159b55621aec447900c78091a0ce4dc8eeb8a04dc5b2a8d`;
- revisão OCI: `d920e6495a53993b916f5b4948dcc583a0cbf208`;
- usuário declarado: `node`;
- porta declarada: `20128/tcp`.

## Isolamento comprovado

O OmniRoute foi iniciado em `127.0.0.1:22128`, separado das portas pessoais `20128` e `20130`, com:

- `Privileged=false`;
- `CapAdd=null` e `CapDrop=["ALL"]`;
- `NoNewPrivs=1`;
- `CapInh`, `CapPrm`, `CapEff`, `CapBnd` e `CapAmb` iguais a zero;
- UID/GID `1000:1000`;
- raiz do contêiner somente leitura;
- zero bind mounts e zero montagem do trust store do host;
- somente três `tmpfs`: `/app/data`, `/home/node` e `/tmp`;
- rede bridge Docker sem `NET_ADMIN`;
- publicação somente em loopback: `127.0.0.1:22128 -> 20128`;
- `OMNIROUTE_MITM_STUB=1` e serviços de background desabilitados;
- segredos efêmeros gerados em memória e nunca exibidos.

Um upstream OpenAI-compatible simulado foi executado em segundo contêiner igualmente sem privilégios, sem bind mounts e sem porta publicada no host.

## Contrato observado

- `/healthz`: HTTP 200, `ok`;
- `/livez`: HTTP 200, `ok`;
- `/readyz`: HTTP 200, `ok`;
- `/api/health`: HTTP 200, `status=ok`;
- login local: HTTP 200;
- criação de chave efêmera: HTTP 201;
- `/v1/models` sem chave: HTTP 401;
- `/v1/models` com chave: HTTP 200 e catálogo OpenAI-compatible;
- criação do nó OpenAI-compatible apontando para o mock: HTTP 201;
- criação da conexão por `POST /api/providers`: HTTP 500, corpo vazio;
- `/v1/chat/completions` sem conexão ativa: HTTP 401, `No active credentials for provider: poc03.`

O log liga o HTTP 500 à exceção `Missing tiktoken_bg.wasm`. A mesma ausência impede o scheduler de saúde de credenciais no startup. A rota `/v1` e a autenticação básica funcionam, mas a conexão necessária para encaminhar uma conversa não pode ser criada pelo contrato suportado do release.

Consequentemente, não foi possível certificar streaming, tool calling, `stream_options.include_usage`, falha injetada, fallback ou limite máximo de tier. Esses itens permanecem **não comprovados**, e não são chamados de sucesso parcial.

## Evento ambiental separado

O daemon Docker do WSL2 reiniciou durante a prova e encerrou tanto os contêineres do PoC quanto os do Coolify. O OmniRoute recebeu SIGTERM e fechou de forma graciosa; esse encerramento não é classificado como falha do OmniRoute. A prova funcional foi repetida após o daemon voltar.

## Integridade do host

Antes e depois da execução:

- Windows `LocalMachine\\Root`: 60 certificados, SHA-256 `D6F2D1358332367705E05C02DCBD526B37AC3000A572DF4402FEB8D32451E881`;
- Windows `hosts`: SHA-256 `8307C254CA3B8382A3F65203C23E27CEDCD2959114B70D5F4DE615E588D8963C`;
- WinHTTP: acesso direto, sem proxy;
- WSL CA bundle: SHA-256 `ecd9dc38bc3efb7dbd6431f57e29d2f8d6a0f0d211e1464b3fef2cbfe266fcd2`;
- WSL `/etc/hosts`: SHA-256 `5613bdf051ac3350b48d3ee0e4c8d8f634d803ca210a36930a8895bcd3433af5`;
- WSL `/etc/resolv.conf`: SHA-256 `519faf0b55f356f6198fcbfa8bea017c2fcd6bed9ff93be78bc4f7819fcc8122`;
- `ip rule`: SHA-256 `03d2c31fd2120382b3e6285f7409129b5bb93c56841dd3df92b5116e5cb5ccea`;
- nenhum certificado com nome OmniRoute, 9Router ou TPROXY;
- nenhuma escuta final em `20128`, `20130` ou `22128`.

A tabela de rotas mudou durante a reinicialização do Docker/Coolify; não foi usada como prova de integridade do OmniRoute. Os trust stores, `hosts`, resolução, regras, proxy e portas — alvos relevantes da E1 — permaneceram iguais.

Os dois contêineres e a rede privada foram removidos. A imagem local fixada permaneceu em cache para reprodução.

## Decisão E2

O OmniRoute deixa de ser pré-requisito da v1.0 e passa a integração externa opcional para usuário avançado, desligada por padrão e nunca empacotada pelo Studio. A v1.0 segue com DeepSeek direto e adapters do `llm-pi-ai` para OpenRouter e Ollama.

A fase 0.5 passava a depender somente da fase 0 e do PoC-01b. Essa ordem foi
substituída pela E4 em 03/09/2026: o teste agora ocorre depois da fase 9 e antes
do piloto, sem bloquear P32/P33/P31-B.

Uma futura reavaliação do OmniRoute exige release exato reproduzível, criação funcional de conexão pelo contrato suportado, execução sem privilégios e todos os testes de streaming, tools, uso, falha e limite de tier.
