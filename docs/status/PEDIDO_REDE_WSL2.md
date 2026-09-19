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
