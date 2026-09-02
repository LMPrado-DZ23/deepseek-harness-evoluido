# PoC-03 — OmniRoute 3.8.51 em instalação descartável

**Resultado:** STOP / BLOCKED pelo gate de segurança

**Snapshot avaliado:** `OmniRoute-release-v3.8.51`

**Regra aplicada:** o PoC deve parar, sem contorno, se a instalação, build ou primeira inicialização exigir CA, alteração de DNS/hosts, proxy do sistema, Agent Bridge, MITM ou TPROXY nativo.

## Resultado executivo

O snapshot não foi compilado, instalado nem iniciado. A inspeção pré-build provou que até o comando `npm run build:secure` entra no pipeline comum e, em Linux/WSL2, tenta executar `npx --yes node-gyp rebuild` em `src/mitm/tproxy/native`. O empacotador também declara a cópia do addon TPROXY, do servidor MITM e de seus shims para o artefato standalone.

Isso aciona o critério de parada definido para o PoC-03. Não foi criado um patch local para contornar a condição, pois isso testaria um derivado diferente do snapshot fixado.

## Evidências determinísticas

1. `package.json:103` define `build:secure` apenas como `OMNIROUTE_BUILD_PROFILE=minimal` seguido do build comum.
2. `scripts/build/build-next-isolated.mjs:332-348` chama `buildTproxyNative(projectRoot)` sem verificar o perfil `minimal` nem uma chave explícita de opt-in.
3. `scripts/build/build-tproxy-native.mjs:30-42` executa em Linux quando existe `binding.gyp`; o arquivo existe no snapshot.
4. `scripts/build/assembleStandalone.mjs:102-109` copia `transparent.node` para o standalone quando produzido.
5. `scripts/build/assembleStandalone.mjs:140-150` copia `src/mitm/server.cjs` e `src/mitm/_internal`.
6. `next.config.mjs:120-126` mostra que o perfil `minimal` substitui somente quatro módulos. Ele não remove o build do TPROXY, a montagem do servidor MITM nem as importações de `manager.runtime`.
7. As rotas de Agent Bridge e MITM são protegidas como `LOCAL_ONLY` e `SPAWN_CAPABLE`; esse controle é útil, mas não atende à regra mais forte do Studio: o componente proibido deve estar fisicamente ausente.

## Integridade da máquina

- Nenhum `node_modules` foi criado no snapshot.
- Nenhum diretório descartável de instalação do PoC-03 foi criado no WSL2.
- Nenhum processo estava escutando nas portas pessoais `20128` e `20130` durante a verificação.
- Windows Root CA: 122 entradas; hash do inventário antes/depois `AFC97DCF729CC81E4ED0D4E7F2F9542C2CEB7F93DBE4AEC5CF0B418AF58CFFFD`.
- WSL2 CA bundle: SHA-256 antes/depois `ecd9dc38bc3efb7dbd6431f57e29d2f8d6a0f0d211e1464b3fef2cbfe266fcd2`.
- Nenhum certificado com nome OmniRoute, 9Router ou TPROXY foi encontrado nas verificações por nome.
- A instalação pessoal não foi usada, iniciada, parada ou alterada.

## Consequência para o plano

- PoC-01b: **GO**.
- PoC-03: **BLOCKED** no gate pré-build.
- Fase 0.5 com pessoas leigas: **ainda não liberada**, pois a condição acordada exigia os dois PoCs aprovados.
- O bloqueio é do artefato OmniRoute 3.8.51 atual, não da arquitetura de adapter `/v1` do Studio.

## Condição objetiva para repetir o PoC-03

Uma nova versão ou distribuição `/v1-only` deve:

1. não invocar `npx`, `node-gyp` ou qualquer build TPROXY no perfil seguro;
2. excluir fisicamente MITM, TPROXY, Agent Bridge, CA, DNS/hosts, proxy do sistema e Caveman do artefato;
3. falhar no release gate se qualquer caminho proibido reaparecer;
4. iniciar apenas em `127.0.0.1`, em porta diferente da instalação pessoal;
5. manter trust stores, hosts, proxy, firewall e rotas idênticos antes/depois;
6. permitir fixar o tier máximo e impedir fallback externo no perfil privado;
7. provar o contrato `/v1`, streaming e contabilização de uso.

## Auditoria de segurança

A varredura Codex Security foi selada com uma ocorrência de baixa severidade e alta confiança (`CWE-693`). A severidade é baixa porque o caminho exige que o construtor local execute a build; apesar disso, o achado é decisivo para o gate do Studio, pois viola diretamente a ausência física dos componentes proibidos.

Scan: `5fa1d5ae-d335-4e6e-b31c-b87465583116`
Digest: `codex-security-snapshot/v1:sha256:826758b822f230476ed8be9c017e1decc523be49c9a8ecb32188048d5ba61b05`
