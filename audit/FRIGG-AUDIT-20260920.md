# FRIGG — auditoria e correções de 20/09/2026

## Proveniência e alcance

- Repositório canônico: `LMPrado-DZ23/deepseek-harness-evoluido`, privado,
  branch padrão **integ**, consultado pela API autenticada do GitHub.
- Base: `997fa20d897a95061db6da17981c0713dce5f8a3`;
  árvore `8131ac9fe3fb75eed5f5aae219221b6e0321d282`.
- ZIP recebido: `deepseek-harness-evoluido-integ (3).zip`, SHA-256
  `8f3e0c94849aa47d4659e78d6ee32ebd65cac230996d3fd177ddc93091ec6165`.
  Embora o nome difira do `(2)` solicitado, o hash é o mesmo informado.
- Todos os **6.167 blobs** do ZIP coincidem com seus OIDs na árvore canônica;
  nenhum ausente ou divergente. A API, não o nome do ZIP, define a base.
- SSH falhou por DNS e Git HTTPS privado não tinha credencial de terminal.
  A API tinha acesso. Não se aplica `BLOCKED_EXTERNAL_REPOSITORY_ACCESS`.
- Para executar as ferramentas Git, o objeto original do commit foi
  reconstruído de payload/assinatura da API e os objetos da árvore foram
  materializados a partir dos bytes conferidos. Commit e árvore coincidiram
  **byte a byte** com seus OIDs; `git fsck --no-reflogs` não apontou falhas.
  É um checkout **shallow no HEAD**, não um clone com histórico completo.
- `git status --short` inicial: vazio; `git branch --show-current`: `integ`;
  `git rev-parse HEAD`: base acima. `git log --oneline -20` local mostra só o
  HEAD por causa do limite shallow; os **20 commits recentes foram consultados
  separadamente pela API**. Nenhum reset de histórico foi realizado.
- `git submodule status --recursive` inicialmente mostrou o submódulo não
  inicializado. O upstream público foi obtido separadamente e colocado em
  `6c705be1ce6774a000d061da41d1823b03a3d42c`; conferência de conteúdo:
  **8.953 entradas**, pin e self-tests aprovados. Nenhuma alteração upstream.

Auditoria independente dos relatos anteriores do repositório, feita por
Codex. Não houve revisão por um segundo auditor nesta entrega. O alcance
principal foi a superfície recente de arquivos, download OCI, reprodução de
testes e coerência do estado/documentação; isto **não é pentest exaustivo**.

## Achados reproduzidos e correções

| ID | Severidade | Reprodução na base | Correção |
| --- | --- | --- | --- |
| AUDIT-OCI-01 | HIGH | CLI calculava SHA-256 de configuração/camada e não comparava; transporte de teste adulterado terminava com exit 0 e `imagem-pronta` | Todos os blobs usam `gravarConferido`; temporário exclusivo, comparação antes de rename e limpeza em `finally` |
| AUDIT-OCI-01b | MEDIUM | Transferência interrompida deixava `.parcial`; downloads dividiam o mesmo nome temporário | Temporários exclusivos no mesmo filesystem; falha preserva destino anterior; concorrência testada |
| AUDIT-FILES-01 | HIGH | 20 uploads simultâneos do mesmo nome retornaram sucesso, mas deixaram apenas 2 arquivos | Publicação por `link`, que reserva o nome atomicamente e não substitui arquivo existente; só `EEXIST` tenta outro nome |
| AUDIT-FILES-01b | HIGH | `enviados` como link para outra pasta permitiu gravar `escape.txt` fora da raiz | Abertura sem seguir link e operações relativas ao descritor de diretório no Linux/WSL; mudança de identidade recusa a publicação |
| AUDIT-FILES-01c | HIGH, análise do caminho de leitura | Download validava um caminho e o reabria em `createReadStream`, com janela de troca | Abre uma vez, confere tipo/identidade, lê pelo mesmo descritor; regressão troca o caminho por link antes de consumir os bytes |
| AUDIT-FILES-01d | HIGH, pré-condição local | A raiz pessoal de um espaço podia ser resolvida silenciosamente para outra pasta por link | Launcher recusa a entrada que não é diretório real no escopo derivado; teste confirma que não cria sessão |
| AUDIT-LOADER-01 | Compatibilidade | `tsx` CLI exige IPC Unix e impediu gates/E2E neste ambiente | Gates TypeScript e servidor E2E executam o mesmo código por `node --import tsx`; nenhum teste removido |
| AUDIT-MOBILE-01 | MEDIUM | Campo de mensagem chegava a 465 px em telas de 320/390 px, cortando controles apesar de o documento não ter overflow | Coluna `minmax(0, 1fr)` e largura mínima zero; regressão mede controles, hit-test e envio real |
| AUDIT-DOC-01 | MEDIUM | README e instrução ativa negavam jornada real já registrada no status/ledger | Texto ativo reconciliado com JORNADA-REAL-01; relatos históricos preservados |

As severidades descrevem impacto potencial no componente, não demonstram
exploração remota sem pré-condições. Em particular, desvio por link exige que
alguém ou algum processo consiga preparar/trocar a árvore de trabalho.
O teste OCI substitui somente o transporte HTTP: executa o CLI real, mas não
prova ataque ao registro real nem execução de imagem adulterada pelo Docker.

## Validação

Medições novas desta sessão, sem reaproveitar contadores históricos:

| Verificação | Resultado |
| --- | --- |
| Build oficial upstream e build dos plugins | PASS; mesmo script upstream por loader Node, sem alterações no submódulo |
| Build Vite da interface após correção móvel | PASS |
| 32 gates do projeto, incluindo tipos de backend e frontend | PASS; tipos, ledger, segredos, portabilidade e referências reconferidos após as últimas alterações |
| Testes unitários da interface | 88 arquivos, 1.075 testes PASS |
| Regressão focada arquivos/sessão/HTTP/OCI | 4 arquivos, 52 testes PASS |
| CLI OCI em processo separado | 7 testes PASS; base anterior falhou nas 3 adulterações |
| Overflow e envio móvel | 8 testes PASS; antes da correção, largura excedida nas duas larguras |
| Falsificações das defesas | 4/4 detectadas: digest, reserva atômica, identidade de pasta, raiz pessoal |
| Suíte geral da raiz | **FAILED:** 4.439 PASS, 173 FAIL, 68 SKIP; 19 arquivos falharam, 246 passaram, 10 pulados |
| PostgreSQL | **NOT_EXECUTED:** Docker e servidor PostgreSQL ausentes |
| Navegador completo | **FAILED:** 172 PASS, 1 FAIL, 3 SKIP em 378,7 s; detalhe da interferência abaixo |
| Projetos, após build concluído | 5 testes PASS em 9,4 s |

A suíte da raiz encontrou `EPERM` em sockets Unix, montagem negada,
filesystem overlayfs recusado pelo gerenciador e `/workspace` gravável por
outros recusado pela restauração. Reexecução focada nos dois últimos módulos
produziu 15 falhas e 40 aprovações. Não houve dispensa dessas proteções.
Isso explica bloqueios observados, **não prova que todas as 173 falhas tenham
causa exclusivamente ambiental**; o restante requer triagem na plataforma
suportada (`NEEDS_REVALIDATION`).

Execuções iniciais do navegador foram descartadas: launcher IPC incompatível,
e, depois, colisão de arquivos de trace entre execuções concorrentes usando
o mesmo diretório de saída. A medição de 176 casos usou diretório exclusivo, mas um build da raiz
executado em paralelo reempacotou `plugins/studio-web/lib/client` durante a
navegação para projetos. O trace registrou HTTP 404 e o corpo literal
"Interface ainda não foi compilada."; os outros quatro testes dessa área
passaram, e os cinco passaram na reexecução posterior sem build simultâneo.
Foi erro de sequência desta auditoria; não é evidência de defeito no fluxo
de projetos nem autoriza afirmar uma suíte completa verde. A CI deve repetir
a execução inteira após os builds. O novo
teste móvel também foi corrigido para medir o rodapé que existe no estado
exercitado, em vez de esperar um aviso presente em outro estado da conversa.

### Evidência visual

Capturas da jornada com servidor de teste, na mesma sessão: [antes](evidence/20260920/mobile-before.png) e [depois](evidence/20260920/mobile-after.png).
O campo e a seta de envio deixam de ser cortados. A mensagem de parada de
emergência resulta de o servidor de teste não montar esse plugin; não é
prova de falha nem de sucesso do serviço real. As capturas não contêm dados
reais de clientes.

### Como repetir

Usar Node 22.23.1 e pnpm 11.7.0, instalar pelos lockfiles e manter o pin
upstream. Depois do build oficial upstream e `pnpm build` na raiz:

```sh
node --test scripts/ponte/puxar-imagem.cli.test.mjs
pnpm exec vitest run plugins/studio-web/tests/assistant-files.spec.ts plugins/studio-web/tests/assistant-session.spec.ts plugins/studio-web/tests/http.spec.ts scripts/ponte/puxar-imagem.spec.mjs
pnpm test
pnpm --dir apps/studio-web test
pnpm --dir apps/studio-web build
pnpm --dir apps/studio-web exec playwright test --output=/tmp/frigg-e2e-unico
pnpm test:postgres
```

Executar `pnpm gates`, que descobre os gates em `package.json` e grava seus
vereditos conforme o mecanismo canônico. Não executar duas instâncias
de Playwright com a mesma porta/diretório de resultados. Para PostgreSQL,
seguir o provisionamento já descrito pelo projeto; ausência do serviço não é
aprovação. Repetir também no Windows/WSL e no ambiente real do titular.

## Limitações e próximos passos

- `BLOCKED_BY_EXTERNAL_DEPENDENCY`: PostgreSQL 16/Docker ausentes nesta sessão.
  A prova de banco retorna `NOT_EXECUTED`, não sucesso.
- Operações Unix e montagens de filesystem têm restrições neste ambiente.
  Os testes que dependem delas não devem ser removidos nem enfraquecidos.
- Runtime desta sessão: Node **24.19.0**, pnpm **11.7.0**. O projeto fixa
  Node **22.23.1** para entrega; a CI nessa versão continua necessária.
- Proteção contra troca concorrente de diretório usa o mecanismo existente
  `openDirectory`/`referenceOf`, com `/proc/self/fd` no Linux/WSL. Sem esse
  mecanismo, checar identidade não prova resistência contra um escritor local
  hostil entre syscalls. Windows nativo/macOS exigem validação e solução nativa
  antes de anunciar a mesma garantia. Não é promessa de paridade multiplataforma.
- As provas de frontend usam o servidor de teste do projeto. Não substituem
  provedor real, construtor Docker real, celular físico nem teste com leigos.
- Não foram usados secrets, provedores pagos nem infraestrutura de produção.
  A jornada Mistral do titular foi lida no ledger, não repetida nesta sessão.
- Comparação com Manus e demais referências: **NOT_EXECUTED**. Protocolo e
  prioridades em `docs/plans/FRIGG-JOURNEY-BENCHMARKS.md`; nenhuma superioridade
  demonstrada. Não adicionar frameworks paralelos para simular paridade.
- Candidatura deve passar pela CI e por revisão antes de ser tratada como
  release. As alterações não constituem autorização de publicação ou deploy.
