# M6.4-A — preflight somente leitura do Windows

Estado: **IMPLEMENTED / REAL MACHINE BLOCKED AS EXPECTED**.

## Contrato

O preflight verifica Windows 11, PowerShell 7, WSL2, filesystem Linux real,
utilitários, Docker/Compose, recursos, virtualização, portas, coerência de
hostname/origem/RP ID, DNS, firewall, relógio, caminhos longos e pin do
upstream. Ele não instala programas, eleva privilégios, inicia serviços, abre
portas nem contata a aplicação.

O processo WSL executa com `env -i`, `bash --noprofile --norc` e uma allowlist
de `PATH`. A pasta pessoal é obtida do cadastro do UID, resolvida sem symlink e
o filesystem, dono e espaço são medidos no caminho efetivo. O perfil local usa
`studio.dz23.localhost:8080`, RP ID `localhost` e somente as portas 8080/8443.
Portas do OmniRoute não pertencem ao gate do Studio.

## Provas

- parser PowerShell dos dois arquivos: PASS;
- 19 cenários herméticos e adversariais: PASS, incluindo a deduplicação de um
  mesmo listener exposto simultaneamente por IPv4 e IPv6;
- regressão completa de `tests/m6`: **17/17 PASS**, incluindo PowerShell e
  Bash reais e o Docker simulado/isolado do lifecycle existente;
- versões e flags malformadas, WSL ausente, filesystem `/mnt`, pouco disco,
  contêiner Windows, ferramenta ausente, porta ocupada, origem divergente, DNS
  ausente e pin adulterado: falham fechados;
- mensagens nativas, caminhos e nomes de processo potencialmente sensíveis são
  redigidos;
- injeção de snapshots/runner fora de `DZ23_M6_TEST_MODE=1`: recusada;
- portabilidade com fixture negativa: PASS;
- `third_party/**`: zero diff.
- P37/licenças: `NOT_PRESENT` nesta base isolada; execução obrigatória na
  candidata de integração antes de qualquer redistribuição.

## Execução real nesta máquina

Resultado em `2026-09-06T05:49:09-03:00`: **BLOCKED**, exit code lógico 2 —
o resultado correto, sem contorno. A execução usou o perfil local com hostname
`studio.dz23.localhost`, origem `http://studio.dz23.localhost:8080`, RP ID
`localhost`, portas 8080/3210 e o caminho desta candidata.

- Windows 11 build 26200, PowerShell 7, WSL2 Ubuntu/ext4, 19 utilitários, Git,
  Compose, CPU, memória, disco Linux, virtualização, firewall, relógio e
  caminhos longos: PASS;
- integração Docker dentro do WSL respondeu como engine Linux, mas o daemon
  pela CLI Windows não estava disponível: BLOCKED;
- porta local 8080 ocupada por `wslrelay`: BLOCKED, com o listener IPv4/IPv6
  deduplicado para uma única ocorrência;
- hostname, origem e RP ID do perfil local: PASS;
- caminho da candidata informado, mas o submódulo upstream não está
  materializado nesse checkout: BLOCKED;
- DNS externo: NOT_CONFIGURED por ser perfil local.

A execução consultou o daemon Docker local, mas não o iniciou. Não houve DNS no
perfil local, conexão com endpoint do Studio, alteração de serviço, arquivo,
firewall, certificado ou rede.

## Limites

- nenhum Compose/build/contêiner foi iniciado;
- nenhuma instalação, update, rollback ou desinstalação foi executada;
- o pin real do checkout não foi provado porque o submódulo upstream não está
  materializado neste worktree;
- perfis Tailscale e público, ACME, SMTP e celular físico: NOT_EXECUTED;
- experiência para pessoas leigas: NOT_VALIDATED.
