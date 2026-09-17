import { describe, expect, it } from 'vitest'

import {
  REQUIRED_ATTESTATIONS,
  type ReviewedRun,
  blocksVerification,
  reviewMessage,
  reviewRun,
} from '../src/independent-review.js'

/**
 * As atestacoes com a FORMA de prova.
 *
 * Eram `'x'.repeat(64)` — sessenta e quatro letras que nao sao hexadecimal, e
 * que passavam porque a revisao so conferia se a string existia. A revisao
 * independente apanhou isto: conferir presenca aprova `acceptance_sha256: "sim"`.
 */
const attestations = Object.fromEntries(REQUIRED_ATTESTATIONS.map(name => [
  name, name === 'builder_image_digest' ? `sha256:${'a'.repeat(64)}` : 'a'.repeat(64),
]))

/**
 * Uma execucao aprovada com TODA a prova no lugar.
 *
 * As QUATRO etapas do construtor, e nao duas: o contrato padrao e
 * `install/build/test/e2e`, e uma execucao que nao registrou `install` e `e2e`
 * nao tem como sustentar que o aplicativo foi instalado e exercitado no
 * navegador. A fixture antiga trazia so `build` e `test` e mesmo assim saia
 * CONFIRMED — porque a revisao olhava as etapas PRESENTES e nunca perguntava
 * quais deviam estar la.
 */
function approved(overrides: Partial<ReviewedRun> = {}): ReviewedRun {
  return {
    state: 'PASSED', stage: 'verify',
    acceptance_checks: [{ id: 'a', label: 'language=pt-BR', status: 'PASSED' }],
    artifact_sha256: 'a'.repeat(64),
    template_integrity: 'VERIFIED',
    attestations,
    steps: [
      { step: 'install', state: 'PASSED' }, { step: 'build', state: 'PASSED' },
      { step: 'test', state: 'PASSED' }, { step: 'e2e', state: 'PASSED' },
    ],
    failure_code: null,
    ...overrides,
  }
}

describe('reviewRun — o caminho confirmado', () => {
  it('prova completa sustenta a afirmacao, e o veredito DIZ contra qual contrato', () => {
    const result = reviewRun(approved())
    expect(result).toMatchObject({ verdict: 'CONFIRMED', problems: [], notAutomated: 0, passed: 1 })
    // Um `CONFIRMED` que nao diga contra o que foi conferido e opiniao.
    expect(result.contract).toEqual(['install', 'build', 'test', 'e2e'])
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

  it('lista de passos AUSENTE deixa de confirmar: sem ela nao ha o que conferir contra o perfil', () => {
    // ESTE TESTE VIROU DE LADO, e a inversao e a correcao. Ele afirmava que a
    // ausencia da lista "nao e acusada", porque execucoes antigas nao tem
    // passos. Era verdade sobre o REGISTRO e falso sobre a REVISAO: ser antiga
    // explica por que a prova falta, nao autoriza confirmar sem ela. Uma
    // revisao independente que confirma o que nao pode conferir e a
    // autoavaliacao de volta, com outro nome.
    const result = reviewRun(approved({ steps: undefined }))
    expect(result.verdict).toBe('INCONCLUSIVE')
    expect(result.problems).toEqual([{ code: 'STEPS_NOT_RECORDED', subject: 'steps' }])
  })

  it('etapa EXIGIDA e ausente do registro nao confirma — o achado que motivou o contrato', () => {
    // Estes dois registros saiam CONFIRMED: lista vazia, e so `build`.
    expect(reviewRun(approved({ steps: [] })).verdict).toBe('INCONCLUSIVE')
    const soBuild = reviewRun(approved({ steps: [{ step: 'build', state: 'PASSED' }] }))
    expect(soBuild.verdict).toBe('INCONCLUSIVE')
    expect(soBuild.problems.map(problem => problem.subject).sort()).toEqual(['e2e', 'install', 'test'])
  })

  it('o contrato do PERFIL manda, e um perfil menor confirma o que ele exige', () => {
    // Um perfil sem navegador nao tem e2e, e exigi-lo reprovaria uma execucao
    // completa para aquele perfil. O contrato vem de quem chama; o que a
    // revisao nao pode e descobri-lo a partir do que foi gravado.
    const semE2e = reviewRun(approved({ steps: [
      { step: 'install', state: 'PASSED' }, { step: 'build', state: 'PASSED' }, { step: 'test', state: 'PASSED' },
    ] }), ['install', 'build', 'test'])
    expect(semE2e.verdict).toBe('CONFIRMED')
    expect(semE2e.contract).toEqual(['install', 'build', 'test'])
  })

  it('atestacao com a forma errada nao sustenta nada', () => {
    // `acceptance_sha256: 'sim'` passava: a revisao conferia se a string
    // existia, nao se ela era um resumo.
    const torta = reviewRun(approved({ attestations: { ...attestations, acceptance_sha256: 'sim' } }))
    expect(torta.verdict).toBe('INCONCLUSIVE')
    expect(torta.problems).toContainEqual({ code: 'ATTESTATION_MALFORMED', subject: 'acceptance_sha256' })
    // O digest da imagem tem forma PROPRIA: um sha256 solto nao serve.
    const semPrefixo = reviewRun(approved({ attestations: { ...attestations, builder_image_digest: 'a'.repeat(64) } }))
    expect(semPrefixo.problems).toContainEqual({ code: 'ATTESTATION_MALFORMED', subject: 'builder_image_digest' })
    // E a impressao do artefato tambem e conferida na forma.
    expect(reviewRun(approved({ artifact_sha256: 'nao-e-um-resumo' })).problems)
      .toContainEqual({ code: 'ATTESTATION_MALFORMED', subject: 'artifact_sha256' })
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
