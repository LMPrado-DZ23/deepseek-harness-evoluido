import { describe, expect, it } from 'vitest'
import { podeOperar, secaoInicial, secoesDePreferencias } from './Preferencias'
import preferencias from '../i18n/preferencias.pt-BR.json'

const TUDO = { autenticado: true, notificacoesSuportadas: true }

describe('as seções das preferências', () => {
  it('nenhuma seção indisponível fica sem dizer o que falta', () => {
    // Esta é a regra inteira contra o botão mudo: "ainda não existe" sem motivo
    // é indistinguível de "quebrado".
    for (const secao of secoesDePreferencias(TUDO)) {
      if (!secao.disponivel) expect(secao.pendencia).toBeTruthy()
    }
  })

  it('TODA pendência tem frase no catálogo — nenhuma cai num identificador cru', () => {
    const frases = preferencias.pendencias as Record<string, string>
    for (const secao of secoesDePreferencias({ autenticado: false, notificacoesSuportadas: false })) {
      if (secao.pendencia !== undefined) expect(frases[secao.pendencia]).toBeTruthy()
    }
  })

  it('TODA seção tem título no catálogo', () => {
    const titulos = preferencias.secoes as Record<string, string>
    for (const secao of secoesDePreferencias(TUDO)) expect(titulos[secao.id]).toBeTruthy()
  })

  it('seção indisponível NÃO pode operar, e a regra tem um lugar só', () => {
    const tema = secoesDePreferencias(TUDO).find(secao => secao.id === 'tema')!
    expect(podeOperar(tema)).toBe(false)
  })

  it('sem sessão, a conta fica indisponível em vez de mostrar uma conta vazia', () => {
    const secoes = secoesDePreferencias({ autenticado: false, notificacoesSuportadas: true })
    expect(secoes.find(secao => secao.id === 'conta')).toMatchObject({ disponivel: false, pendencia: 'semSessao' })
  })

  it('sem API de notificação no navegador, a seção diz isso — e não oferece um botão', () => {
    const secoes = secoesDePreferencias({ autenticado: true, notificacoesSuportadas: false })
    expect(secoes.find(secao => secao.id === 'notificacoes')).toMatchObject({ disponivel: false })
  })

  it('as capacidades que EXISTEM apontam para os destinos reais, e não para "#"', () => {
    const secoes = secoesDePreferencias(TUDO)
    for (const id of ['habilidades', 'plugins', 'biblioteca']) {
      const secao = secoes.find(item => item.id === id)!
      expect(secao.disponivel).toBe(true)
      expect(secao.href).toMatch(/^\/studio\//u)
    }
  })

  it('abre na primeira seção DISPONÍVEL, e não na primeira da lista', () => {
    expect(secaoInicial(secoesDePreferencias(TUDO))).toBe('conta')
    /*
      Sem sessão e sem notificação, as duas primeiras caem — e a primeira que
      sobra é ATALHOS, que vem antes de Uso na ordem da referência e passou a
      ser disponível quando o produto passou a ter um atalho de verdade.

      Esta expectativa já mudou TRÊS vezes, e as três por FATIA ENTREGUE: era
      Habilidades quando tudo entre uma e outra estava pendente, virou Uso,
      virou Atalhos, e agora é IDIOMA — que vem antes de Atalhos na ordem da
      referência e passou a ser disponível quando o produto passou a ter três
      idiomas de verdade. A regra nunca mudou — "abre na primeira disponível" —,
      e é por isso que o teste é sobre ela, e não sobre um identificador fixo.
    */
    expect(secaoInicial(secoesDePreferencias({ autenticado: false, notificacoesSuportadas: false }))).toBe('idioma')
  })

  it('sem nenhuma seção disponível, devolve `null` em vez de inventar uma', () => {
    expect(secaoInicial([])).toBeNull()
  })

  it('os três grupos da referência estão todos presentes', () => {
    const grupos = new Set(secoesDePreferencias(TUDO).map(secao => secao.grupo))
    expect(grupos).toEqual(new Set(['configuracoes', 'capacidades', 'dados']))
  })
})
