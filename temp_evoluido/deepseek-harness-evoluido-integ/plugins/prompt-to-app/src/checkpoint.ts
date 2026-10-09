import type { StudioRun } from './model.js'

/**
 * O ponto ao qual a pessoa pode VOLTAR com segurança, e a prova de que ele existe.
 *
 * Antes disto não havia desfazer nenhum: uma tentativa que falhava deixava a
 * pessoa parada num código em inglês, sem nenhum lugar para onde voltar e sem
 * saber o que tinha sido conservado. Este módulo é puro de propósito - ele não
 * toca em disco, não apaga nada e não muda estado; ele apenas LÊ o registro de
 * execução e responde se aquela tentativa é um ponto seguro.
 *
 * A regra que atravessa o arquivo inteiro: nada aqui inventa um verde. Um ponto
 * seguro é uma tentativa cujos PASSOS PASSARAM (`state: 'PASSED'`) e cuja
 * INTEGRIDADE DO TEMPLATE foi conferida e bateu (`template_integrity:
 * 'VERIFIED'`), e que ainda tem diretório conservado para onde voltar. Qualquer
 * outra coisa - inclusive uma execução antiga que passou antes de existir o
 * registro de integridade - é um ponto NÃO seguro com o motivo dito por extenso.
 *
 * Hoje nenhuma execução chega a `PASSED`: o pipeline lança
 * `ACCEPTANCE_ATTESTATION_UNAVAILABLE` no caminho de sucesso enquanto a
 * atestação de aceite não existir (E-05). A resposta honesta, então, é "não há
 * ponto seguro para voltar" com esse motivo - e não um verde inventado.
 */

/**
 * Por que uma tentativa NÃO é um ponto seguro.
 *
 * Cada valor é derivado do registro de execução, nunca de um palpite: a tela
 * transforma isto em uma frase, e uma frase sem lastro seria pior do que
 * nenhuma.
 */
export type CheckpointBlocker =
  /** Os passos rodaram, mas a prova de que os critérios de aceite foram conferidos não existe (E-05). */
  | 'ACCEPTANCE_ATTESTATION_UNAVAILABLE'
  /** A conferência de integridade do template recusou a tentativa. */
  | 'TEMPLATE_INTEGRITY_FAILED'
  /** A tentativa passou, mas é anterior ao registro de integridade: não há o que conferir. */
  | 'INTEGRITY_NOT_RECORDED'
  /** A tentativa não chegou ao fim com todos os passos aprovados. */
  | 'STEPS_DID_NOT_PASS'

/** Nenhuma tentativa conservou diretório: não há nem ponto seguro nem ponto inseguro. */
export const NO_ATTEMPT = 'NO_ATTEMPT'

/** O valor que o `run_directory` recebe quando nada chegou a ser criado em disco. */
export const RUN_DIRECTORY_NOT_CREATED = 'not-created'

export type CheckpointIntegrity = 'VERIFIED' | 'FAILED' | 'UNKNOWN'

/**
 * O que ficou CONSERVADO de uma tentativa.
 *
 * Tudo aqui vem do registro de execução e do relato gravado ao lado dele - não
 * existe uma segunda fonte de verdade que possa discordar da primeira.
 */
export interface RunCheckpoint {
  readonly run_id: string
  readonly attempt: number
  readonly created_at: string
  /** O diretório da execução, que continua em disco. Desfazer NUNCA o apaga. */
  readonly run_directory: string
  /** O sha da árvore exportada, quando a execução chegou a exportar uma. */
  readonly tree_sha256: string | null
  /** Os critérios de aceite lidos do relatório da própria execução. */
  readonly acceptance_checks: StudioRun['acceptance_checks']
  readonly integrity: CheckpointIntegrity
  /** Verdadeiro só quando os passos passaram E a integridade bateu. */
  readonly green: boolean
  /** `null` exatamente quando `green` é verdadeiro. */
  readonly blocker: CheckpointBlocker | null
}

/**
 * Traduz o registro de integridade da execução para o do checkpoint.
 *
 * Ausente vira `UNKNOWN` e não `VERIFIED`: o campo é opcional porque execuções
 * gravadas antes dele existirem continuam válidas, e tratar silêncio como prova
 * seria a definição de verde artificial.
 * @param run - o registro da execução.
 * @returns o que se pode afirmar sobre a integridade daquela tentativa.
 */
function integrityOf(run: StudioRun): CheckpointIntegrity {
  return run.template_integrity ?? 'UNKNOWN'
}

/**
 * Por que esta tentativa não serve como ponto de retorno, ou `null` se ela serve.
 * @param run - o registro da execução.
 * @returns o motivo, na ordem em que ele é descoberto.
 */
function blockerOf(run: StudioRun): CheckpointBlocker | null {
  if (run.state !== 'PASSED') {
    return run.failure_code === 'ACCEPTANCE_ATTESTATION_UNAVAILABLE'
      ? 'ACCEPTANCE_ATTESTATION_UNAVAILABLE'
      : run.failure_code === 'TEMPLATE_INTEGRITY_FAILED'
        ? 'TEMPLATE_INTEGRITY_FAILED'
        : 'STEPS_DID_NOT_PASS'
  }
  const integrity = integrityOf(run)
  if (integrity === 'FAILED') return 'TEMPLATE_INTEGRITY_FAILED'
  if (integrity === 'UNKNOWN') return 'INTEGRITY_NOT_RECORDED'
  return null
}

/**
 * O que foi conservado de cada tentativa, da mais antiga para a mais recente.
 *
 * Execução sem diretório não vira checkpoint: não há nada conservado, e listar
 * um ponto de retorno vazio convidaria a pessoa a voltar para lugar nenhum.
 * Execução ainda em andamento também fica de fora - ela ainda não terminou de
 * ser o que quer que venha a ser.
 * @param runs - os registros de execução do projeto.
 * @returns um checkpoint por tentativa conservada.
 */
export function runCheckpoints(runs: readonly StudioRun[]): readonly RunCheckpoint[] {
  return runs
    .filter(run => run.run_directory !== RUN_DIRECTORY_NOT_CREATED && run.state !== 'PENDING' && run.state !== 'RUNNING')
    .map((run): RunCheckpoint => {
      const blocker = blockerOf(run)
      return {
        run_id: run.run_id,
        attempt: run.attempt,
        created_at: run.finished_at ?? run.started_at,
        run_directory: run.run_directory,
        tree_sha256: run.artifact_sha256 ?? null,
        acceptance_checks: run.acceptance_checks,
        integrity: integrityOf(run),
        green: blocker === null,
        blocker,
      }
    })
    .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.attempt - right.attempt)
}

/**
 * O ponto seguro mais recente, ou `null` quando não existe nenhum.
 * @param checkpoints - a lista devolvida por `runCheckpoints`.
 * @returns o último ponto seguro.
 */
export function latestGreenCheckpoint(checkpoints: readonly RunCheckpoint[]): RunCheckpoint | null {
  return [...checkpoints].reverse().find(checkpoint => checkpoint.green) ?? null
}

/**
 * Por que NÃO há ponto seguro, quando não há.
 *
 * O motivo é o da tentativa mais recente, porque é essa que a pessoa acabou de
 * ver falhar - e é dela que ela quer saber. `null` quando existe ponto seguro:
 * aí não há o que explicar.
 * @param checkpoints - a lista devolvida por `runCheckpoints`.
 * @returns o motivo, `NO_ATTEMPT` se nada foi conservado, ou `null`.
 */
export function noGreenReason(checkpoints: readonly RunCheckpoint[]): CheckpointBlocker | typeof NO_ATTEMPT | null {
  if (latestGreenCheckpoint(checkpoints) !== null) return null
  return checkpoints.at(-1)?.blocker ?? NO_ATTEMPT
}
