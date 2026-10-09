import { describe, expect, it } from 'vitest'
import { portugueseText } from './i18n-baseline-shared.mjs'

/**
 * O buraco que este arquivo fecha não é hipotético.
 *
 * O detector olhava só para ACENTO e para uma lista de palavras acentuadas.
 * `plugins/route-health/src/service.ts` escrevia as frases da pessoa SEM
 * ACENTO, com um comentário admitindo o motivo, e o portão dizia PASS. O verde
 * media o que o detector enxergava, não o que existia — e a contagem de
 * literais herdados ("caiu de 92 para 1") media a mesma cegueira.
 *
 * Por isso o caso central aqui é o par: a MESMA frase, com e sem acento, tem
 * de ser detectada das duas formas. Se um dia alguém trocar o detector por
 * outro que volte a depender do acento, é este teste que reprova.
 */
describe('detector de texto pt-BR do portão de i18n', () => {
  const frases = [
    ['Rota desligada neste espaço de trabalho; ela não é escolhida enquanto continuar assim.',
     'Rota desligada neste espaco de trabalho; ela nao e escolhida enquanto continuar assim.'],
    ['Perfil equilibrado: a IA local está em uso e nada sai deste computador.',
     'Perfil equilibrado: a IA local esta em uso e nada sai deste computador.'],
    ['Perfil equilibrado: a IA local não está disponível; usando a rota externa configurada.',
     'Perfil equilibrado: a IA local nao esta disponivel; usando a rota externa configurada.'],
    ['Teto de gasto do escopo estourado; nenhuma rota paga foi acionada.',
     'Teto de gasto do escopo estourado; nenhuma rota paga foi acionada.'],
    ['Meia-abertura: uma chamada decide se o circuito fecha ou reabre.',
     'Meia-abertura: uma chamada decide se o circuito fecha ou reabre.'],
  ]

  it('detecta a frase COM acento e a MESMA frase sem acento', () => {
    for (const [comAcento, semAcento] of frases) {
      expect(portugueseText(comAcento), comAcento).toBe(true)
      expect(portugueseText(semAcento), semAcento).toBe(true)
    }
  })

  it('não confunde inglês, identificador, caminho, cabeçalho e SQL com português', () => {
    // Uma lista de permissão que reprova o que não é texto da pessoa vira ruído,
    // e ruído é como um portão morre: alguém desliga.
    for (const texto of [
      'The selected route is not healthy',
      'no space left on device',
      'Do not use this in production',
      'read_image', 'str_replace_editor', 'content-type',
      'application/json; charset=utf-8',
      'example.com', 'data/studio-capture.json', '1em 2em',
      'SELECT count(*) AS total FROM auth_users',
    ]) expect(portugueseText(texto), texto).toBe(false)
  })

  it('não confunde identificador de uma palavra com frase da pessoa', () => {
    // `'projeto'` é o nome de um parâmetro de endereço e `'equilibrado'` é um
    // perfil que o produto compara por valor. Mandá-los para o catálogo seria
    // guardar CHAVE DE DADO num catálogo de texto — e o portão que exige isso
    // é o portão que alguém desliga.
    for (const identificador of ['projeto', 'equilibrado', 'melhor-qualidade', 'privado-local', 'EXCLUIDOS.txt']) {
      expect(portugueseText(identificador), identificador).toBe(false)
    }
    // Mas uma palavra ACENTUADA sozinha continua sendo texto: ela não tem como
    // ser identificador neste código.
    expect(portugueseText('Verificação')).toBe(true)
  })
})
