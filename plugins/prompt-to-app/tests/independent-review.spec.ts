import { describe, expect, it } from 'vitest'

import {
  REQUIRED_ATTESTATIONS,
  type ReviewedRun,
  blocksVerification,
  reviewMessage,
  reviewRun,
} from '../src/independent-review.js'

const attestations = Object.fromEntries(REQUIRED_ATTESTATIONS.map(name => [name, 'x'.repeat(64)]))

/** Uma execucao aprovada com TODA a prova no lugar. */
function approved(overrides: Partial<ReviewedRun> = {}): ReviewedRun {
  return {
    state: 'PASSED', stage: 'verify',
    acceptance_checks: [{ id: 'a', label: 'language=pt-BR', status: 'PASSED' }],
    artifact_sha256: 'a'.repeat(64),
    template_integrity: 'VERIFIED',
    attestations,
    steps: [{ step: 'build', state: 'PASSED' }, { step: 'test', state: 'PASSED' }],
    failure_code: null,
    ...overrides,
  }
}

describe('reviewRun — o caminho confirmado', () => {
  it('prova completa sustenta a afirmacao', () => {
    expect(reviewRun(approved())).toEqual({ verdict: 'CONFIRMED', problems: [], notAutomated: 0, passed: 1 })
  })

  it('execucao que NAO afirmou aprovacao sai como NAO REVISADA, e nunca confirmada', () => {
    // `CONFIRMED` quer dizer "as provas sustentam o que foi afirmado". Aqui o
    // significado e "nao olhei", e usar a mesma palavra faria um segundo
    // chamador ler "confirmado" sobre uma execucao reprovada.
    const result = reviewRun(approved({ state: 'FAILED', artifact_sha256: null, template_integrity: undefined }))
    expect(result.verdict).toBe('NOT_REVIEWED')
    expect(result.problems).toEqual([])
    // E ela nao bloqueia: nao ha aprovacao a bloquear.
    expect(blocksVerification(result)).toBe(false)
    expect(reviewMessage(result)).toBeUndefined()
  })
})

describe('reviewRun — contradicoes', () => {
  it('criterio REPROVADO numa execucao aprovada e contradicao', () => {
    const result = reviewRun(approved({ acceptance_checks: [{ id: 'a', label: 'página:Início', status: 'FAILED' }] }))
    expect(result.verdict).toBe('CONTRADICTED')
    expect(result.problems).toContainEqual({ code: 'CHECK_FAILED', subject: 'página:Início' })
  })

  it('integridade do template REPROVADA e contradicao', () => {
    const result = reviewRun(approved({ template_integrity: 'FAILED' }))
    expect(result.verdict).toBe('CONTRADICTED')
    expect(result.problems).toContainEqual({ code: 'INTEGRITY_FAILED', subject: 'template' })
  })

  it('passo do construtor REPROVADO e contradicao', () => {
    const result = reviewRun(approved({ steps: [{ step: 'test', state: 'FAILED' }] }))
    expect(result.verdict).toBe('CONTRADICTED')
    expect(result.problems).toContainEqual({ code: 'STEP_NOT_PASSED', subject: 'test' })
  })

  it('execucao aprovada COM motivo de falha esta se contradizendo sozinha', () => {
    const result = reviewRun(approved({ failure_code: 'build: exit 1' }))
    expect(result.verdict).toBe('CONTRADICTED')
    expect(result.problems).toContainEqual({ code: 'FAILURE_CODE_ON_PASS', subject: 'build: exit 1' })
  })

  it('motivo de falha VAZIO nao e contradicao', () => {
    // Um campo vazio e um campo nao preenchido, e acusar por ele faria toda
    // execucao gravada por um caminho antigo parecer contraditoria.
    expect(reviewRun(approved({ failure_code: '' })).verdict).toBe('CONFIRMED')
  })

  it('a contradicao vence a prova ausente: as duas sao ditas, o veredito e o pior', () => {
    const result = reviewRun(approved({
      acceptance_checks: [{ id: 'a', label: 'x', status: 'FAILED' }],
      artifact_sha256: null,
    }))
    expect(result.verdict).toBe('CONTRADICTED')
    expect(result.problems).toContainEqual({ code: 'CHECK_FAILED', subject: 'x' })
    expect(result.problems).toContainEqual({ code: 'ARTIFACT_MISSING', subject: 'artifact' })
  })
})

describe('reviewRun — prova ausente nunca vira prova', () => {
  it('criterio ainda PENDENTE numa execucao aprovada nao passou silenciosamente', () => {
    const result = reviewRun(approved({ acceptance_checks: [{ id: 'a', label: 'entidade:Cliente', status: 'PENDING' }] }))
    expect(result.verdict).toBe('INCONCLUSIVE')
    expect(result.problems).toContainEqual({ code: 'CHECK_STILL_PENDING', subject: 'entidade:Cliente' })
  })

  it('NENHUM criterio conferido nao e aprovacao', () => {
    const result = reviewRun(approved({ acceptance_checks: [] }))
    expect(result.verdict).toBe('INCONCLUSIVE')
    expect(result.problems).toContainEqual({ code: 'NO_CHECKS', subject: 'acceptance' })
  })

  it('artefato sem impressao nao sustenta o que foi entregue', () => {
    expect(reviewRun(approved({ artifact_sha256: null })).verdict).toBe('INCONCLUSIVE')
    expect(reviewRun(approved({ artifact_sha256: '' })).verdict).toBe('INCONCLUSIVE')
    expect(reviewRun(approved({ artifact_sha256: undefined })).verdict).toBe('INCONCLUSIVE')
  })

  it('integridade AUSENTE nao e integridade verificada', () => {
    // O proprio esquema diz que ausente quer dizer "nao registrado". A revisao
    // existe justamente para nao converter um no outro.
    const result = reviewRun(approved({ template_integrity: undefined }))
    expect(result.verdict).toBe('INCONCLUSIVE')
    expect(result.problems).toContainEqual({ code: 'INTEGRITY_NOT_RECORDED', subject: 'template' })
  })

  it('cada atestacao ausente e nomeada, uma por uma', () => {
    for (const name of REQUIRED_ATTESTATIONS) {
      const partial = { ...attestations }
      delete (partial as Record<string, string>)[name]
      const result = reviewRun(approved({ attestations: partial }))
      expect(result.verdict).toBe('INCONCLUSIVE')
      expect(result.problems).toContainEqual({ code: 'ATTESTATION_MISSING', subject: name })
    }
  })

  it('bloco de atestacoes inteiro ausente acusa todas as seis', () => {
    const result = reviewRun(approved({ attestations: undefined }))
    expect(result.verdict).toBe('INCONCLUSIVE')
    expect(result.problems.filter(problem => problem.code === 'ATTESTATION_MISSING')).toHaveLength(REQUIRED_ATTESTATIONS.length)
  })

  it('atestacao presente e VAZIA conta como ausente', () => {
    const result = reviewRun(approved({ attestations: { ...attestations, sbom_sha256: '' } }))
    expect(result.verdict).toBe('INCONCLUSIVE')
    expect(result.problems).toContainEqual({ code: 'ATTESTATION_MISSING', subject: 'sbom_sha256' })
  })

  it('passo que ficou RODANDO numa execucao aprovada nao terminou', () => {
    const result = reviewRun(approved({ steps: [{ step: 'e2e', state: 'RUNNING' }] }))
    expect(result.verdict).toBe('INCONCLUSIVE')
    expect(result.problems).toContainEqual({ code: 'STEP_NOT_PASSED', subject: 'e2e' })
  })

  it('lista de passos AUSENTE nao e acusada: ela e anterior ao registro de passos', () => {
    // Execucoes antigas nao tem passos. Acusa-las diria que algo falta onde o
    // que existe e so uma versao mais velha do registro.
    expect(reviewRun(approved({ steps: undefined })).verdict).toBe('CONFIRMED')
  })
})

describe('reviewRun — criterios nao automatizados', () => {
  it('nao automatizado NAO bloqueia, e NAO entra na conta dos aprovados', () => {
    const result = reviewRun(approved({
      acceptance_checks: [
        { id: 'a', label: 'x', status: 'PASSED' },
        { id: 'b', label: 'o site precisa ser bonito', status: 'NOT_AUTOMATED' },
      ],
    }))
    expect(result.verdict).toBe('CONFIRMED')
    expect(result.passed).toBe(1)
    expect(result.notAutomated).toBe(1)
  })

  it('SO criterios nao automatizados ainda confirma, mas diz que ninguem conferiu', () => {
    const result = reviewRun(approved({ acceptance_checks: [{ id: 'b', label: 'x', status: 'NOT_AUTOMATED' }] }))
    expect(result.verdict).toBe('CONFIRMED')
    expect(result.notAutomated).toBe(1)
    expect(reviewMessage(result)).toBeDefined()
  })
})

describe('reviewMessage', () => {
  it('a confirmacao limpa nao diz nada', () => {
    expect(reviewMessage(reviewRun(approved()))).toBeUndefined()
  })

  it('a contradicao e a inconclusao dizem QUANTOS pontos, e sao frases diferentes', () => {
    const contradicted = reviewMessage(reviewRun(approved({ template_integrity: 'FAILED' })))
    const inconclusive = reviewMessage(reviewRun(approved({ artifact_sha256: null })))
    expect(contradicted).toBeDefined()
    expect(inconclusive).toBeDefined()
    expect(contradicted).not.toBe(inconclusive)
  })

  it('a inconclusao NAO afirma que algo deu errado', () => {
    const message = reviewMessage(reviewRun(approved({ artifact_sha256: null }))) ?? ''
    expect(message).toContain('não dá para afirmar')
  })
})

describe('blocksVerification', () => {
  it('contradicao e prova ausente bloqueiam', () => {
    expect(blocksVerification({ verdict: 'CONTRADICTED', problems: [], notAutomated: 0, passed: 0 })).toBe(true)
    // Deixar passar o que nao se consegue sustentar e transformar ausencia de
    // prova em prova — que e o defeito inteiro que esta revisao existe para pegar.
    expect(blocksVerification({ verdict: 'INCONCLUSIVE', problems: [], notAutomated: 0, passed: 0 })).toBe(true)
  })

  it('criterio nao automatizado NAO bloqueia', () => {
    // Bloquear aqui reprovaria toda criacao cujo criterio a pessoa escreveu em
    // prosa — que e a maioria delas.
    expect(blocksVerification({ verdict: 'CONFIRMED', problems: [], notAutomated: 3, passed: 1 })).toBe(false)
  })
})
