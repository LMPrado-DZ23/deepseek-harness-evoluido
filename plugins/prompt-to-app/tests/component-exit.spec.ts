import { describe, expect, it } from 'vitest'

import {
  DECLARACAO_DE_LIMITE, ETAPAS_DE_SAIDA, MINIMO_DE_REPETICOES, PREFIXOS_DE_SEGREDO, PROBLEMAS_DE_SAIDA,
  capacidadeSobrevive, ganho, problemasDaSaida,
  type Medicao, type PlanoDeSaida,
} from '../src/component-exit.js'

const todasFeitas = Object.fromEntries(ETAPAS_DE_SAIDA.map(e => [e, true])) as PlanoDeSaida['etapas']
const plano = (over: Partial<PlanoDeSaida> = {}): PlanoDeSaida => ({
  candidato: 'CAND-X', capacidade: 'gerar componente', alternativa: 'geradores do prompt-to-app',
  etapas: todasFeitas, execucoes_desconhecidas: [], exportado: ['artefatos.zip', 'historico.json'],
  contratos_externos_abertos: [], ...over,
})
const medicao = (over: Partial<Medicao> = {}): Medicao => ({
  jornada: 'criar-cadastro', aceites_passados: 8, aceites_totais: 10, custo: 10, intervencoes: 2, repeticoes: 5, ...over,
})

describe('AT-135 — retirar um componente sem perder ativo', () => {
  it('o plano completo pode ser executado', () => {
    expect(problemasDaSaida(plano())).toEqual([])
  })

  it('as cinco etapas existem, e qualquer uma pendente impede', () => {
    expect(ETAPAS_DE_SAIDA).toHaveLength(5)
    for (const etapa of ETAPAS_DE_SAIDA) {
      const parcial = plano({ etapas: { ...todasFeitas, [etapa]: false } })
      expect(problemasDaSaida(parcial), etapa).toContain('ETAPA_PENDENTE')
    }
  })

  it('SEM alternativa a capacidade morre junto, e a saida e recusada', () => {
    // A mesma pergunta da AT-114, do outro lado: recusar um candidato nao podia
    // apagar a capacidade, e RETIRAR um que ja estava em uso tambem nao pode.
    // E mais provavel aqui, porque sair da trabalho e "a gente nao faz mais
    // isso" e a forma mais barata de terminar.
    const semSaida = plano({ alternativa: '  ' })
    expect(problemasDaSaida(semSaida)).toContain('SEM_ALTERNATIVA')
    expect(capacidadeSobrevive(semSaida)).toBe(false)
    expect(capacidadeSobrevive(plano())).toBe(true)
  })

  it('SEGREDO dentro do pacote exportado e recusado', () => {
    // A saida e o momento em que tudo e empacotado, e e onde uma credencial vai
    // junto sem ninguem olhar.
    for (const prefixo of PREFIXOS_DE_SEGREDO) {
      const comSegredo = plano({ exportado: ['artefatos.zip', `${prefixo}ALGUMA_COISA`] })
      expect(problemasDaSaida(comSegredo), prefixo).toContain('SEGREDO_NO_PACOTE')
    }
  })

  it('execucao com desfecho DESCONHECIDO impede a saida', () => {
    expect(problemasDaSaida(plano({ execucoes_desconhecidas: ['run-9'] }))).toContain('EXECUCAO_ABERTA')
  })

  it('declarar credencial retirada com CONTRATO aberto e fingir que a relacao acabou', () => {
    // Desligar a integracao nao encerra a assinatura. Dizer que sim faz alguem
    // parar de prestar atencao numa cobranca que continua chegando.
    const fingido = plano({ contratos_externos_abertos: ['assinatura-mensal'] })
    expect(problemasDaSaida(fingido)).toContain('CONTRATO_FINGIDO_ENCERRADO')
  })

  it('contrato aberto SEM declarar credencial retirada nao e fingimento: e um fato pendente', () => {
    const honesto = plano({
      contratos_externos_abertos: ['assinatura-mensal'],
      etapas: { ...todasFeitas, RETIRAR_CREDENCIAIS: false },
    })
    expect(problemasDaSaida(honesto)).not.toContain('CONTRATO_FINGIDO_ENCERRADO')
    expect(problemasDaSaida(honesto)).toContain('ETAPA_PENDENTE')
  })

  it('devolve TODOS os problemas, em ordem estavel', () => {
    // Uma saida pela metade descoberta em etapas e pior que uma recusada: a
    // ferramenta ja parou de aceitar trabalho quando o segundo problema aparece.
    const ruim = plano({ alternativa: '', execucoes_desconhecidas: ['r1'], exportado: ['DZ23_CHAVE'] })
    const problemas = problemasDaSaida(ruim)
    expect(problemas.length).toBeGreaterThanOrEqual(3)
    expect(problemas).toEqual(PROBLEMAS_DE_SAIDA.filter(p => problemas.includes(p)))
  })
})

describe('AT-136 — ganho nao e presumido', () => {
  it('mais aceites e melhor, e o veredito vem com o que ele NAO cobre', () => {
    const resultado = ganho(medicao({ aceites_passados: 6 }), medicao({ aceites_passados: 9 }))
    expect(resultado).toEqual({ ganho: 'MELHOR', declaracao: DECLARACAO_DE_LIMITE })
    expect(DECLARACAO_DE_LIMITE).toContain('Não mede liderança de mercado')
    expect(DECLARACAO_DE_LIMITE).toContain('não prevê lucro')
  })

  it('menos aceites e pior', () => {
    expect(ganho(medicao({ aceites_passados: 9 }), medicao({ aceites_passados: 6 })).ganho).toBe('PIOR')
  })

  it('UMA execucao nao e medida', () => {
    // Uma execucao a mais rapida nao e uma ferramenta mais rapida.
    expect(ganho(medicao({ repeticoes: 1 }), medicao())).toEqual({ ganho: 'NAO_MEDIDO', motivo: 'POUCAS_REPETICOES' })
    expect(ganho(medicao(), medicao({ repeticoes: MINIMO_DE_REPETICOES - 1 })).ganho).toBe('NAO_MEDIDO')
    expect(ganho(medicao({ repeticoes: MINIMO_DE_REPETICOES }), medicao({ repeticoes: MINIMO_DE_REPETICOES })).ganho).not.toBe('NAO_MEDIDO')
  })

  it('jornadas DIFERENTES nao se comparam', () => {
    // Comparar a criacao de um cadastro com a de um painel mede o trabalho, e
    // nao a ferramenta.
    expect(ganho(medicao({ jornada: 'criar-cadastro' }), medicao({ jornada: 'criar-painel' })))
      .toEqual({ ganho: 'NAO_MEDIDO', motivo: 'JORNADAS_DIFERENTES' })
  })

  it('total de criterios diferente torna a taxa incomparavel', () => {
    expect(ganho(medicao({ aceites_totais: 10 }), medicao({ aceites_totais: 12 })))
      .toEqual({ ganho: 'NAO_MEDIDO', motivo: 'ACEITES_INCOMPARAVEIS' })
  })

  it('empate nos aceites desempata por INTERVENCAO humana, e nao por custo', () => {
    // Custo depende de preco, que muda por fora. Intervencao e trabalho de
    // gente, e e o que a pessoa de fato sente.
    expect(ganho(medicao({ intervencoes: 5 }), medicao({ intervencoes: 1 })).ganho).toBe('MELHOR')
    expect(ganho(medicao({ intervencoes: 1 }), medicao({ intervencoes: 5 })).ganho).toBe('PIOR')
    expect(ganho(medicao({ custo: 100 }), medicao({ custo: 1 })).ganho).toBe('IGUAL')
  })

  it('igual em tudo e IGUAL, e nao "melhor por ser novo"', () => {
    expect(ganho(medicao(), medicao()).ganho).toBe('IGUAL')
  })
})
