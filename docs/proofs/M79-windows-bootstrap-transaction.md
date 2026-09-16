# M79 — Bootstrap portátil e transacional do upstream

Estado: **GO para bootstrap em WSL2; falha segura no Windows sem permissão de symlink**.

Branch isolada: `codex/m79-windows-bootstrap-transaction`. Base M78:
`e1d8134d4fd534c16109c0dbde60a28ba117931b`. Ponta funcional:
`0199f13f7ee428f482da65c95674777a913f6367`.

## Problema observado

O roteiro documentado para um clone novo não era executável no Windows:

1. `bootstrap-upstream.mjs` exigia symlinks físicos antes de chamar o
   materializador;
2. o materializador apagava o placeholder antes de tentar criar o symlink;
3. sem Modo de Desenvolvedor, a criação falhava com `EPERM` e deixava o
   checkout incompleto;
4. no clone WSL2, o postinstall do Harness recusava o `core.worktree` gravado
   na configuração comum do submódulo.

## Correção

- o bootstrap sincroniza e materializa o gitlink fixado, prova origem, gitlink,
  commit, tree, limpeza e manifesto sem exigir ainda o tipo físico dos links;
- só depois converte placeholders cujo blob corresponde ao manifesto;
- o symlink é criado em caminho temporário antes de o placeholder ser movido;
  falha na criação preserva o arquivo original e falha na promoção o restaura;
- `core.worktree` só é migrado para `config.worktree` quando aponta exatamente
  para o submódulo esperado, os arquivos de configuração são regulares, não há
  configuração local preexistente e nenhuma extensão Git desconhecida existe;
- o bootstrap repete a prova completa, agora exigindo symlinks reais, antes de
  emitir `UPSTREAM_BOOTSTRAP=PASS`.

## Prova negativa real no Windows

Sem autorização para mudar a política do Windows, a execução terminou de forma
segura e acionável:

```text
UPSTREAM_BOOTSTRAP=FAIL não foi possível criar symlink ...;
placeholder preservado. Ative o Modo de Desenvolvedor do Windows ou execute o bootstrap no WSL2
```

O placeholder permaneceu com 9 bytes e SHA-256
`47dc3e3d863cfb5727b87d785d09abf9743c0a72`, igual ao blob do Git. Nenhum
arquivo temporário ficou no submódulo e a árvore permaneceu limpa.

## Prova positiva em clone novo WSL2/ext4

Clone descartável preservado em
`/home/leandro/dz23-gates/m79-bootstrap-0199f13`:

```text
UPSTREAM_CONTENT=PASS entries=8953 sha256=862b92782c2f5cd67f81debd1116b16150dfafd84fb4ce2602a729f9cf3d26dc
UPSTREAM_BOOTSTRAP=PASS commit=6c705be1ce6774a000d061da41d1823b03a3d42c
```

No mesmo clone, sem Docker:

- instalação congelada e `build:official` do Harness: `PASS`;
- instalação congelada filtrada e build do Studio: `PASS`;
- typecheck raiz: `PASS`;
- contratos do bootstrap: `9/9 PASS`;
- self-test do pin: cinco fixtures negativas e prova positiva: `PASS`;
- portabilidade, i18n e gates de domínios/rotas: `PASS`;
- suíte raiz: 125 arquivos aprovados, 6 pulados; 2.027 testes aprovados,
  62 pulados, zero falha, com um worker;
- PostgreSQL físico permaneceu explicitamente pulado por ausência de DSN;
  não foi apresentado como reexecução.

## Auditoria de segurança

Codex Security Diff Scan
`0d486eee-a292-4b2b-8cfd-e8ce91897824` sobre `e1d8134..0199f13`:

- seis arquivos alterados inspecionados; três fontes executáveis no inventário
  canônico e três mudanças de CI, teste e documentação revisadas como suporte;
- superfícies de pin/origem, symlink transacional, configuração Git e caminhos
  do manifesto cobertas;
- cobertura completa, zero candidato e zero vulnerabilidade reportável;
- TAC consultivo indisponível porque o conector não está conectado;
- revisão independente por subagente indisponível; o agente principal cobriu
  integralmente o diff.

Relatório selado:
`C:/Users/<voce>/.codex/security-scans/m79-windows-bootstrap-transaction/0199f13f7ee428f482da65c95674777a913f6367_20260906T220137Z_6mmzelaq/report.md`.

## Limites honestos

- a prova Windows demonstrou preservação e mensagem de recuperação, não
  bootstrap positivo; isso exige Modo de Desenvolvedor ou WSL2;
- Docker não foi chamado;
- lifecycle Windows real com imagens finais continua `NOT_EXECUTED`;
- testes PostgreSQL reais não foram executados nesta fatia;
- nenhum merge na principal, push, PR, deploy, limpeza ou exclusão foi feito.
