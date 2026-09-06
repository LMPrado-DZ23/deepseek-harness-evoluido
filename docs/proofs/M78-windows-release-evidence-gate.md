# M78 — Gate de evidência do lifecycle Windows

Estado: **GO para o verificador; lifecycle real NOT_EXECUTED**.

Branch isolada: `codex/m78-windows-release-evidence-gate`. Base M77:
`6d886392fe42e6e1ea591839a7c52f082ac9cf96`. Ponta funcional:
`56fd26f7fb40964f44094c43165f54fdda1f3efa`.

## O que foi construído

`Test-Dz23LifecycleEvidence.ps1` é um gate somente leitura para uma execução
real do M77. Ele exige:

- `lifecycle-report.json` diretamente no diretório físico de evidências;
- SHA-256 final do relatório capturado por um canal separado;
- três commits esperados, completos, distintos e em minúsculas;
- estado `PASS`, modo `REAL` e estado final
  `UNINSTALLED_DATA_PRESERVED`;
- exatamente 17 fases na ordem documentada, com uma única falha esperada e
  rollback confirmado;
- três artefatos físicos distintos, sem traversal ou reparse point, com hashes
  ligados ao relatório autenticado;
- snapshots válidos do mesmo Windows, PowerShell, WSL e nível de elevação;
- trust store idêntico em comparação independente e no relatório de comparação.

O M77 agora devolve `report_sha256` imediatamente depois da escrita atômica do
relatório final. O operador precisa guardar esse valor fora do diretório M77;
sem ele, o M78 falha fechado antes de decodificar ou interpretar o JSON.

## Achado de segurança e correção

O primeiro scan encontrou uma falha MÉDIA de autenticidade
(`CWE-345`): os hashes dos artefatos estavam no próprio relatório não
autenticado. O teste positivo provava que era possível fabricar relatório,
snapshots e hashes coerentes sem executar M77 e ainda obter `PASS`.

O commit `56fd26f7fb40964f44094c43165f54fdda1f3efa` fechou a causa:

- `ExpectedReportSha256` é obrigatório;
- o hash é comparado sobre os bytes antes do parse;
- o relatório autenticado liga transitivamente os hashes dos três artefatos;
- um pacote inteiro refeito, embora internamente coerente, falha quando não
  corresponde ao digest externo confiável.

Scans:

- candidato `6d88639..6a31455`: scan
  `e6d2519a-344e-4520-8d6b-960ae9f6b389`, cobertura completa, um achado MÉDIO;
- verificação `6a31455..56fd26f`: scan
  `82ac84ac-993a-454d-bd69-359a45e9eecd`, cobertura completa de dois arquivos
  de produção, zero achados;
- TAC não pôde ser verificado porque o conector não estava autenticado;
- revisão delegada não estava disponível; o agente principal cobriu o diff.

Relatório final de verificação:
`C:/Users/zodyp/.codex/security-scans/m78-windows-release-evidence-gate/56fd26f7fb40964f44094c43165f54fdda1f3efa_20260906T205902Z_mq2qste8/report.md`.

## Provas executadas

```text
node --test tests/m6/windows-*.test.mjs
tests=23 pass=23 fail=0 duration=264011.5231ms
M6.4-A Windows preflight: PASS (19 cenários herméticos e adversariais)
M6 Windows shell: PASS (PowerShell e Bash reais, Docker isolado)
```

```text
PORTABILITY_SELF_TEST=PASS negative_fixture_rejected=true
PORTABILITY=PASS source=git findings=0
```

Gate P37:

```text
status=PASS
files_scanned=849
package_manifests=22
license_files=1
findings=0
```

O typecheck raiz não foi declarado verde: este checkout isolado continua sem o
pacote workspace materializado `@deepseek-ai/dsh-storage`. M78 não adiciona
TypeScript de produção.

## Limites honestos

- Docker Desktop permaneceu desligado;
- instalação, atualização, rollback e reinstalação reais continuam
  `NOT_EXECUTED`;
- um digest só é âncora se for guardado separadamente do pacote de evidências;
- assinatura/proveniência OCI e automação pública de release continuam fora
  desta fatia;
- nenhum merge na principal, push, PR, deploy, purge ou exclusão foi feito.

