import { describe, expect, it } from 'vitest'
import { projectNameFromBrief } from './projectName'

describe('o nome do projeto vem da ideia', () => {
  it('ideia curta vira nome inteiro, sem reticências', () => {
    expect(projectNameFromBrief('  agenda da clínica  ')).toBe('agenda da clínica')
  })

  it('não corta no meio de uma palavra', () => {
    // Era exatamente isto que a lista mostrava: "…e receber con".
    const name = projectNameFromBrief('quero uma página para apresentar minha clínica e receber contatos')
    expect(name.endsWith('…')).toBe(true)
    expect(name).not.toContain('con…')
    expect(name.length).toBeLessThanOrEqual(60)
    // O que sobrou termina numa palavra INTEIRA da ideia original — a
    // invariante, e não uma palavra específica que muda se o limite mudar.
    const brief = 'quero uma página para apresentar minha clínica e receber contatos'
    const last = name.slice(0, -1).trim().split(' ').at(-1)!
    expect(brief.split(' ')).toContain(last)
  })

  it('uma palavra sozinha maior que o limite é cortada seco, e ainda avisa', () => {
    const name = projectNameFromBrief('a'.repeat(90))
    expect(name.length).toBeLessThanOrEqual(60)
    expect(name.endsWith('…')).toBe(true)
  })

  it('espaço repetido e quebra de linha não viram nome esquisito', () => {
    expect(projectNameFromBrief('agenda\n\n  da   clínica')).toBe('agenda da clínica')
  })
})
