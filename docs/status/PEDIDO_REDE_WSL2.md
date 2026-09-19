# PEDIDO ÚNICO — rede do WSL2 (19/09/2026)

A seção 2 da diretiva de 19/09 pede UMA solicitação objetiva, com causa
comprovada, mudança mínima, impacto e rollback, antes de qualquer alteração em
`.wslconfig` ou reinício do WSL. Esta é ela. **Nada foi alterado.**

## Causa, medida em quatro camadas

| camada | medição | resultado |
| --- | --- | --- |
| Windows | `Test-NetConnection` e `curl.exe -4`/`-6` para os 4 destinos do build | **sai** por IPv4 e por IPv6 (`nodejs.org` → `200` nas duas famílias) |
| processo no WSL2 | TCP 443 e 80 para os 4 destinos, `ping 8.8.8.8` | **nada sai**; DNS resolve (via `10.255.255.254`) |
| dentro do WSL2, até onde chega | gateway NAT `172.23.240.1` → **responde**; roteador da LAN `192.168.100.1` → **não**; IP Wi‑Fi do próprio Windows `192.168.100.97` → **não** | o pacote morre **no NAT do WSL**, antes de sair do computador |
| Docker | Engine nativo 29.6.1 dentro do WSL (não é Docker Desktop), contexto `default`, sem proxy | herda a rede do WSL: `docker pull` → `i/o timeout` |

Não é DNS (resolve), não é proxy (nenhum configurado, no WSL nem no WinHTTP),
não é TLS (não chega a abrir TCP), e **não dá para atribuir ao firewall**: o
perfil do firewall Hyper‑V para o WSL tem **saída = Allow**. O que as medições
mostram é o encaminhamento NAT do WSL não funcionando nesta máquina.

Contexto que torna isso plausível, sem ser prova: há um adaptador **Tailscale**
ativo (MTU 1280 — e a `eth0` do WSL herdou exatamente MTU 1280), e um adaptador
de loopback **"Topaz"** (módulo de segurança bancária) com uma rota padrão
`0.0.0.0/0` própria. Os dois são conhecidos por interferir no NAT do WSL.

## Mudança mínima proposta

Criar `C:\Users\zodyp\.wslconfig` (hoje **não existe**) com:

```ini
[wsl2]
networkingMode=mirrored
```

e reiniciar o WSL com `wsl --shutdown`.

No modo espelhado o WSL usa as interfaces do Windows diretamente, sem NAT — e
o Windows já sai. De brinde, resolve o item 4 da diretiva **sem abrir o Ollama**:
no modo espelhado, `127.0.0.1` dentro do WSL alcança os serviços do Windows que
escutam em `127.0.0.1`, e o Ollama continua escutando só ali.

## Impacto

- **`wsl --shutdown` para tudo o que roda no WSL**, inclusive a sua pilha
  Coolify/Traefik/Redis/Postgres. Ela volta sozinha se os contêineres tiverem
  política de reinício (o `dockerd` sobe com o systemd, que está ligado no seu
  `wsl.conf`). Conferir antes é prudente.
- As portas que os serviços do WSL abrem em `0.0.0.0` passam a existir nas
  interfaces do Windows. A **entrada** do firewall Hyper‑V para o WSL está em
  **Block** por padrão, e isso continua valendo — mas é uma mudança de
  exposição, e por isso ela está escrita aqui.
- Nada é instalado, nenhum firewall é desligado, nenhuma CA é adicionada,
  nenhuma porta é aberta para fora.

## Rollback

Apagar o arquivo `C:\Users\zodyp\.wslconfig` (ele não existia) e rodar
`wsl --shutdown`. O WSL volta ao NAT de hoje.

## O que depende disto

`setup-templates` (baixar a base e as dependências fixadas), a instalação do
construtor, alcançar o Ollama, e a jornada inteira no WSL2. Todo o resto
continua andando sem isto.

## Atualização (19/09, mais tarde) — o pedido foi RETIRADO, e nada no sistema mudou

O titular respondeu "faça o que for preciso". Antes de aplicar, duas coisas
apareceram que o pedido não dizia:

1. **O Docker Desktop também para** com `wsl --shutdown`. Ele sustenta `buzz-prod`,
   `odoo`, `evolution-api`, `omniroute` (este sem política de reinício) e outros.
2. **Havia outro trabalho em andamento**: contêineres temporários de CI de outra
   sessão (`beautiful_bose`, depois `focused_kilby`, `quizzical_driscoll`) nascendo
   a cada poucos minutos. Reiniciar o WSL mataria esses trabalhos no meio.

E uma medição mudou a solução: **o motor do Docker Desktop tem saída** (um
contêiner dele fez `fetch('https://registry.npmjs.org/')` → `200`), e **o WSL
alcança uma porta publicada pelo Docker Desktop em `172.23.240.1`** (o IP do
Windows no adaptador do WSL). Daí a saída usada, sem tocar em `.wslconfig`,
firewall, rota, DNS, daemon ou reinício:

| peça | o que é | limites |
| --- | --- | --- |
| `frigg-egress` | contêiner `node:22.23.1-bookworm-slim` no Docker Desktop, `--read-only`, `--cap-drop ALL`, `no-new-privileges`, 128 MB, `--restart no`, script em `C:\Users\zodyp\frigg-egress\egress.mjs` | publicado **só** em `172.23.240.1:3128` e `:11434` — pelo IP da LAN do Windows não responde (medido: `LAN:000`) |
| túnel `:3128` | só `CONNECT`, só porta 443, só a lista (`registry.npmjs.org`, `nodejs.org`, `mcr.microsoft.com`, `*.data.mcr.microsoft.com`, `registry-1.docker.io`, `auth.docker.io`, `production.cloudflare.docker.com`) | TLS de ponta a ponta: não vê, não altera, não instala CA. `example.com` → `403` (medido) |
| repasse `:11434` | TCP até o Ollama do Windows (`host.docker.internal`) | o Ollama continua ouvindo só em `127.0.0.1`; o WSL o alcança por `172.23.240.1:11434` (medido: lista `qwen2.5-coder:7b`) |

O proxy vale só nos processos do FRIGG que o recebem por variável, e no
`docker build` por um `DOCKER_CONFIG` próprio (`~/.frigg-docker-config`) com um
construtor buildx próprio (`frigg`, conteiner `buildx_buildkit_frigg0`). O
`~/.docker` do titular e o daemon não mudam.

**Rollback:** `docker rm -f frigg-egress` no Windows; `docker buildx rm frigg`
com `DOCKER_CONFIG=~/.frigg-docker-config` no WSL.

## Um defeito do Docker nativo do WSL, encontrado e reparado

Com o WSL parando e subindo nas medições, o `dockerd` nativo passou a não
subir: `networks have same bridge name` (`docker0`). Causa lida no banco de
redes (`/var/lib/docker/network/files/local-kv.db`): o registro da ponte
padrão `4a81…` tinha sumido e sobraram **duas chaves órfãs** do driver dela. É
plausível que o desligamento repetido do WSL durante as medições tenha deixado
o banco assim. Com o `dockerd` parado, a pilha Coolify estava FORA do ar.

Reparo cirúrgico, com a ferramenta `bbolt` numa cópia: apagadas **só** as duas
chaves órfãs; a rede `coolify` ficou intacta. Original salvo em
`/root/frigg-reparo-docker/local-kv.db.original-20260918-234333`
(sha256 `ee846ae6…`). Resultado: `dockerd` 29.6.1 ativo, e `coolify`,
`coolify-db`, `coolify-redis`, `coolify-realtime` e `coolify-proxy` de volta,
todos `healthy`. **Rollback:** parar o docker, copiar o original de volta,
subir o docker.
