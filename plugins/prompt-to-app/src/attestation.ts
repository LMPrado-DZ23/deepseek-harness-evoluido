/**
 * As atestações de uma execução verificada — o que o Studio pode AFIRMAR sobre
 * um artefato que ele mesmo construiu.
 *
 * Este arquivo existe porque o caminho de SUCESSO do pipeline estava morto: ao
 * fim de um ciclo que passava, `pipeline.ts` lançava
 * `ACCEPTANCE_ATTESTATION_UNAVAILABLE`, e com ele iam embora o estado
 * `VERIFIED_PROTOTYPE`, a prévia e o aviso à pessoa. A saída não podia ser
 * inventar uma atestação para acender o verde: uma atestação que não olha
 * evidência é pior que atestação nenhuma, porque ela AUTORIZA. Então aqui os
 * documentos são DERIVADOS do que realmente aconteceu, e o veredito de
 * aprovação exige todas as evidências ao mesmo tempo.
 *
 * Quatro documentos, cada um respondendo a uma pergunta diferente:
 *
 * - **aceitação**: os critérios que a pessoa escreveu foram conferidos, um a um?
 * - **manifesto**: exatamente QUAIS arquivos formam este artefato, e com que conteúdo?
 * - **SBOM**: de que ele é feito - quais dependências, em que versão?
 * - **proveniência**: quem construiu, a partir de quê, com que imagem e política?
 *
 * Nenhum deles é assinado por enquanto, e isso está declarado: hash não é
 * assinatura. O que eles dão hoje é INTEGRIDADE verificável e rastreabilidade;
 * o que eles não dão é prova de origem contra alguém que possa reescrever o
 * disco.
 */
import { createHash } from 'node:crypto'
import { t } from './i18n.js'

/** O estado de um critério de aceitação, como o relatório do app o traz. */
export type AttestationCheckStatus = 'PENDING' | 'PASSED' | 'FAILED' | 'NOT_AUTOMATED'

export interface AttestationCheck {
  readonly id: string
  readonly kind: string
  readonly status: AttestationCheckStatus
}

/**
 * Os fatos que SÓ a sessão do construtor conhece.
 *
 * Chegam pelo `BuilderLifecycleFinished`. São opcionais lá de propósito: uma
 * sessão que não consegue declarar com que imagem e sob que política ela
 * construiu NÃO pode produzir uma atestação de aprovação, e a execução continua
 * bloqueada. Um valor padrão aqui seria a mentira mais barata do repositório.
 */
export interface BuilderAttestationFacts {
  readonly image_digest: string
  readonly policy_sha256: string
  readonly scope_id: string
}

/** Um arquivo do artefato, com o conteúdo resumido. */
export interface ManifestEntry {
  readonly path: string
  readonly sha256: string
  readonly bytes: number
}

export interface AcceptanceAttestation {
  readonly schema_version: 1
  readonly kind: 'dz23.acceptance'
  readonly run_id: string
  readonly project_id: string
  readonly artifact_sha256: string
  readonly template_integrity: 'VERIFIED' | 'FAILED'
  readonly builder: BuilderAttestationFacts
  readonly checks: readonly AttestationCheck[]
  readonly summary: {
    readonly total: number
    readonly passed: number
    readonly failed: number
    readonly not_automated: number
    readonly pending: number
  }
  readonly lifecycle_passed: boolean
  readonly verdict: 'PASSED' | 'FAILED'
  readonly attested_at: string
}

export interface ManifestAttestation {
  readonly schema_version: 1
  readonly kind: 'dz23.manifest'
  readonly run_id: string
  readonly artifact_sha256: string
  readonly file_count: number
  readonly total_bytes: number
  readonly files: readonly ManifestEntry[]
  readonly attested_at: string
}

/** Uma dependência declarada pelo app gerado. */
export interface SbomComponent {
  readonly name: string
  readonly version: string
  readonly scope: 'runtime' | 'development'
}

export interface SbomAttestation {
  readonly schema_version: 1
  readonly kind: 'dz23.sbom'
  readonly run_id: string
  readonly artifact_sha256: string
  /**
   * De onde a lista saiu.
   *
   * `declared` significa que ela é o que o `package.json` DECLARA, e não a
   * árvore instalada resolvida. A diferença importa e por isso ela é dita: um
   * intervalo `^1.2.3` não diz qual versão foi instalada, e chamar isso de
   * "o que está dentro do artefato" seria mais preciso do que a verdade.
   */
  readonly source: 'declared' | 'unavailable'
  readonly unavailable_reason: string | null
  readonly components: readonly SbomComponent[]
  readonly attested_at: string
}

export interface ProvenanceAttestation {
  readonly schema_version: 1
  readonly kind: 'dz23.provenance'
  readonly run_id: string
  readonly project_id: string
  readonly plan_id: string
  readonly artifact_sha256: string
  readonly manifest_sha256: string
  readonly builder: BuilderAttestationFacts
  readonly inputs: {
    readonly app_spec_sha256: string
    readonly template_id: string
    readonly template_version: string
    readonly template_integrity: 'VERIFIED' | 'FAILED'
  }
  readonly build: {
    readonly offline: boolean
    readonly frozen_lockfile: boolean
    readonly attempt: number
  }
  readonly signed: false
  readonly signature_note: string
  readonly attested_at: string
}

/**
 * JSON canônico: chaves ordenadas, sem espaço.
 *
 * Sem isto o hash de um documento dependeria da ordem em que os campos foram
 * escritos, e reordenar uma linha do código mudaria o `sha256` de uma
 * atestação já emitida.
 * @param value - o documento.
 * @returns o texto canônico.
 */
export function canonicalDocument(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalDocument).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, item]) => `${JSON.stringify(name)}:${canonicalDocument(item)}`)
    .join(',')}}`
}

/**
 * O resumo de um documento de atestação.
 * @param value - o documento.
 * @returns o SHA-256 em hexadecimal do texto canônico.
 */
export function documentSha256(value: unknown): string {
  return createHash('sha256').update(canonicalDocument(value)).digest('hex')
}

/**
 * A atestação de aceitação.
 *
 * O veredito é DERIVADO e exige tudo ao mesmo tempo: nenhum critério reprovado,
 * nenhum critério ainda pendente, o ciclo do construtor concluído e a
 * integridade do template verificada. Qualquer buraco reprova. Não existe
 * caminho neste arquivo que produza `PASSED` sem essas quatro coisas — que é
 * exatamente o que separa uma atestação de um carimbo.
 * @param input - os fatos da execução.
 * @returns o documento e o resumo dele.
 */
export function acceptanceAttestation(input: {
  readonly runId: string
  readonly projectId: string
  readonly artifactSha256: string
  readonly templateIntegrity: 'VERIFIED' | 'FAILED'
  readonly builder: BuilderAttestationFacts
  readonly checks: readonly AttestationCheck[]
  readonly lifecyclePassed: boolean
  readonly attestedAt: string
}): { readonly document: AcceptanceAttestation, readonly sha256: string } {
  const count = (status: AttestationCheckStatus): number => input.checks.filter(check => check.status === status).length
  const summary = {
    total: input.checks.length,
    passed: count('PASSED'),
    failed: count('FAILED'),
    not_automated: count('NOT_AUTOMATED'),
    pending: count('PENDING'),
  }
  // Um conjunto VAZIO de critérios não é aprovação: é ausência de conferência.
  // Sem esta linha, um relatório sem nenhum critério passaria com nota máxima.
  const verdict: 'PASSED' | 'FAILED' = summary.total > 0
    && summary.failed === 0
    && summary.pending === 0
    && input.lifecyclePassed
    && input.templateIntegrity === 'VERIFIED'
    ? 'PASSED'
    : 'FAILED'
  const document: AcceptanceAttestation = {
    schema_version: 1,
    kind: 'dz23.acceptance',
    run_id: input.runId,
    project_id: input.projectId,
    artifact_sha256: input.artifactSha256,
    template_integrity: input.templateIntegrity,
    builder: input.builder,
    checks: [...input.checks].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
    summary,
    lifecycle_passed: input.lifecyclePassed,
    verdict,
    attested_at: input.attestedAt,
  }
  return { document, sha256: documentSha256(document) }
}

/**
 * O manifesto do artefato: quais arquivos, com que conteúdo.
 * @param input - os arquivos já resumidos e a identificação da execução.
 * @returns o documento e o resumo dele.
 */
export function manifestAttestation(input: {
  readonly runId: string
  readonly artifactSha256: string
  readonly files: readonly ManifestEntry[]
  readonly attestedAt: string
}): { readonly document: ManifestAttestation, readonly sha256: string } {
  // Ordem de caminho, sempre. A leitura do disco devolve em ordem de sistema de
  // arquivos, e um manifesto que mudasse de hash conforme o sistema que o leu
  // não serviria para comparar duas construções.
  const files = [...input.files].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  const document: ManifestAttestation = {
    schema_version: 1,
    kind: 'dz23.manifest',
    run_id: input.runId,
    artifact_sha256: input.artifactSha256,
    file_count: files.length,
    total_bytes: files.reduce((total, file) => total + file.bytes, 0),
    files,
    attested_at: input.attestedAt,
  }
  return { document, sha256: documentSha256(document) }
}

/**
 * A lista de dependências que o app gerado DECLARA.
 *
 * Quando o `package.json` não pode ser lido, a lista sai vazia com o motivo
 * escrito e `source: 'unavailable'` — nunca uma lista vazia que se pareça com
 * "este app não depende de nada".
 * @param input - o conteúdo do `package.json`, quando houver.
 * @returns o documento e o resumo dele.
 */
export function sbomAttestation(input: {
  readonly runId: string
  readonly artifactSha256: string
  readonly packageJson: unknown
  readonly attestedAt: string
}): { readonly document: SbomAttestation, readonly sha256: string } {
  const components: SbomComponent[] = []
  let source: 'declared' | 'unavailable' = 'declared'
  let unavailable: string | null = null
  const manifest = input.packageJson
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    source = 'unavailable'
    unavailable = 'PACKAGE_JSON_UNREADABLE'
  } else {
    for (const [field, scope] of [['dependencies', 'runtime'], ['devDependencies', 'development']] as const) {
      const section = (manifest as Record<string, unknown>)[field]
      if (typeof section !== 'object' || section === null || Array.isArray(section)) continue
      for (const [name, version] of Object.entries(section as Record<string, unknown>)) {
        if (typeof version !== 'string') continue
        components.push({ name, version, scope })
      }
    }
  }
  components.sort((left, right) => (left.name < right.name ? -1
    : left.name > right.name ? 1
      : left.scope.localeCompare(right.scope)))
  const document: SbomAttestation = {
    schema_version: 1,
    kind: 'dz23.sbom',
    run_id: input.runId,
    artifact_sha256: input.artifactSha256,
    source,
    unavailable_reason: unavailable,
    components,
    attested_at: input.attestedAt,
  }
  return { document, sha256: documentSha256(document) }
}

/**
 * A proveniência: quem construiu, a partir de quê, com que imagem e política.
 * @param input - os fatos da construção.
 * @returns o documento e o resumo dele.
 */
export function provenanceAttestation(input: {
  readonly runId: string
  readonly projectId: string
  readonly planId: string
  readonly artifactSha256: string
  readonly manifestSha256: string
  readonly builder: BuilderAttestationFacts
  readonly appSpecSha256: string
  readonly templateId: string
  readonly templateVersion: string
  readonly templateIntegrity: 'VERIFIED' | 'FAILED'
  readonly attempt: number
  readonly attestedAt: string
}): { readonly document: ProvenanceAttestation, readonly sha256: string } {
  const document: ProvenanceAttestation = {
    schema_version: 1,
    kind: 'dz23.provenance',
    run_id: input.runId,
    project_id: input.projectId,
    plan_id: input.planId,
    artifact_sha256: input.artifactSha256,
    manifest_sha256: input.manifestSha256,
    builder: input.builder,
    inputs: {
      app_spec_sha256: input.appSpecSha256,
      template_id: input.templateId,
      template_version: input.templateVersion,
      template_integrity: input.templateIntegrity,
    },
    // Verdadeiro por construção: o construtor roda sem rede e com o lockfile
    // congelado. Se um dia deixar de rodar assim, este campo tem de deixar de
    // ser literal antes de a promessa continuar sendo feita.
    build: { offline: true, frozen_lockfile: true, attempt: input.attempt },
    signed: false,
    signature_note: t('attestation.hashIsNotSignature'),
    attested_at: input.attestedAt,
  }
  return { document, sha256: documentSha256(document) }
}

/** Os quatro resumos, do jeito que a execução os guarda. */
export interface AttestationDigests {
  readonly acceptance_sha256: string
  readonly manifest_sha256: string
  readonly sbom_sha256: string
  readonly provenance_sha256: string
  readonly builder_image_digest: string
  readonly policy_sha256: string
}
