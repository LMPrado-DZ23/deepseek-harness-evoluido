import { stagingArtifactSchema, type StagingArtifact } from './model.js'
import type { StagingActor, StagingSourcePort } from './service.js'

/**
 * A ponte entre uma execução VERIFICADA do prompt-to-app e o artefato que o
 * staging aceita publicar.
 *
 * Até que as atestações existissem (E-05), esta ponte não podia existir de
 * forma honesta: o `StagingArtifact` exige dez campos — hash do artefato, do
 * manifesto, da aceitação, do SBOM, da proveniência, a imagem do construtor e a
 * política — e o Studio produzia UM. Preencher os outros nove com qualquer
 * coisa seria fabricar atestação, e atestação fabricada AUTORIZA.
 *
 * Agora eles são reais, e esta ponte só faz uma coisa: recusar tudo que não
 * seja uma execução aprovada com as atestações completas.
 */

/** O recorte de uma execução do prompt-to-app que este adaptador lê. */
export interface VerifiedRunView {
  readonly run_id: string
  readonly project_id: string
  readonly org_id: string
  readonly tenant_id: string
  readonly state: string
  readonly artifact_sha256: string | null
  readonly template_integrity?: 'VERIFIED' | 'FAILED'
  readonly finished_at: string | null
  readonly attestations?: {
    readonly acceptance_sha256: string
    readonly manifest_sha256: string
    readonly sbom_sha256: string
    readonly provenance_sha256: string
    readonly builder_image_digest: string
    readonly policy_sha256: string
  }
}

export interface VerifiedRunSource {
  /**
   * As execuções de um projeto, JÁ no escopo de quem pergunta.
   *
   * O escopo é aplicado por quem lê, e conferido de novo aqui. As duas coisas
   * juntas de propósito: se um dia o leitor deixar de filtrar, a ponte continua
   * recusando; se a ponte deixar de filtrar, o leitor continua recusando.
   */
  runs(actor: StagingActor, projectId: string): readonly VerifiedRunView[]
}

/**
 * As mensagens desta classe são DIAGNÓSTICO, e ficam em inglês de propósito.
 *
 * O que a pessoa lê vem do catálogo, pelo `code`, na camada HTTP. Duas frases
 * para a mesma recusa - uma aqui e uma no catálogo - acabariam divergindo, e a
 * que a pessoa lê seria a que ninguém revisou.
 */
export class StagingSourceError extends Error {
  constructor(readonly code:
    | 'NO_VERIFIED_RUN'
    | 'RUN_NOT_VERIFIED'
    | 'ATTESTATIONS_MISSING'
    | 'TEMPLATE_INTEGRITY_FAILED'
    | 'ARTIFACT_MISSING',
  message: string) {
    super(message)
  }
}

/**
 * A referência opaca do artefato.
 *
 * Ela identifica o CONTEÚDO, e não um caminho: um caminho absoluto no
 * computador de quem hospeda não é assunto do provedor de staging, e mudaria
 * entre instalações do mesmo artefato.
 * @param artifactSha256 - o hash da árvore exportada.
 * @returns a referência.
 */
export function artifactRef(artifactSha256: string): string {
  return `dz23-artifact:sha256-${artifactSha256}`
}

/**
 * A execução mais recente que pode ir para staging.
 *
 * "Mais recente" é por `finished_at`, e só entre as APROVADAS: uma execução que
 * falhou depois de uma que passou não apaga a que passou, mas também não pode
 * ser escolhida por ser a última.
 * @param runs - as execuções do projeto.
 * @param projectId - o projeto.
 * @param scope - organização e inquilino de quem está pedindo.
 * @param runId - uma execução específica, quando a pessoa nomeia uma.
 * @returns a execução escolhida.
 */
export function selectVerifiedRun(
  runs: readonly VerifiedRunView[],
  projectId: string,
  scope: { readonly orgId: string, readonly tenantId: string },
  runId?: string,
): VerifiedRunView {
  const owned = runs.filter(run => run.project_id === projectId
    && run.org_id === scope.orgId
    && run.tenant_id === scope.tenantId)
  if (runId !== undefined) {
    const named = owned.find(run => run.run_id === runId)
    // Uma execução nomeada que não existe NESTE escopo é "não encontrada", e
    // não "escolho outra": publicar algo diferente do que a pessoa nomeou seria
    // o pior desfecho possível numa operação com efeito externo.
    if (named === undefined) throw new StagingSourceError('NO_VERIFIED_RUN', `run ${runId} is not in this project scope`)
    return named
  }
  const passed = owned
    .filter(run => run.state === 'PASSED')
    .sort((left, right) => Date.parse(right.finished_at ?? '') - Date.parse(left.finished_at ?? ''))
  const latest = passed[0]
  if (latest === undefined) throw new StagingSourceError('NO_VERIFIED_RUN', 'no verified run in this project')
  return latest
}

/**
 * O artefato selado de uma execução verificada.
 *
 * Cada recusa aqui tem um código próprio porque elas pedem gestos diferentes de
 * quem está publicando: "não há execução verificada" pede gerar de novo;
 * "faltam atestações" pede rodar de novo numa versão que as produza; "a
 * integridade do template falhou" é um problema de segurança e não de fluxo.
 * @param run - a execução escolhida.
 * @returns o artefato validado pelo esquema do staging.
 */
export function artifactFromRun(run: VerifiedRunView): StagingArtifact {
  if (run.state !== 'PASSED') {
    throw new StagingSourceError('RUN_NOT_VERIFIED', `run ${run.run_id} is not approved`)
  }
  if (run.artifact_sha256 === null) {
    throw new StagingSourceError('ARTIFACT_MISSING', `run ${run.run_id} exported no artifact`)
  }
  // A integridade do template é conferida aqui DE NOVO, e não só na execução:
  // o que vai para staging tem efeito fora do Studio, e um registro antigo -
  // gravado antes de o campo existir - não pode passar por "conferido".
  if (run.template_integrity !== 'VERIFIED') {
    throw new StagingSourceError('TEMPLATE_INTEGRITY_FAILED', `template integrity of run ${run.run_id} was not verified`)
  }
  const attestations = run.attestations
  if (attestations === undefined) {
    throw new StagingSourceError('ATTESTATIONS_MISSING', `run ${run.run_id} predates artifact attestations`)
  }
  return stagingArtifactSchema.parse({
    project_id: run.project_id,
    run_id: run.run_id,
    artifact_ref: artifactRef(run.artifact_sha256),
    artifact_sha256: run.artifact_sha256,
    manifest_sha256: attestations.manifest_sha256,
    acceptance_sha256: attestations.acceptance_sha256,
    sbom_sha256: attestations.sbom_sha256,
    provenance_sha256: attestations.provenance_sha256,
    builder_image_digest: attestations.builder_image_digest,
    policy_sha256: attestations.policy_sha256,
  })
}

/**
 * A porta de origem do staging, ligada às execuções reais do prompt-to-app.
 * @param source - o runtime de onde as execuções são lidas.
 * @returns a porta.
 */
export function verifiedRunSourcePort(source: VerifiedRunSource): StagingSourcePort {
  return {
    async verifiedArtifact(actor: StagingActor, projectId: string, runId?: string): Promise<StagingArtifact> {
      const run = selectVerifiedRun(source.runs(actor, projectId), projectId, { orgId: actor.orgId, tenantId: actor.tenantId }, runId)
      return await Promise.resolve(artifactFromRun(run))
    },
  }
}
