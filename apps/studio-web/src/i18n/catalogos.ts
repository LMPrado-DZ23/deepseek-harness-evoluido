import ptRail from './rail.pt-BR.json'
import enRail from './rail.en.json'
import esRail from './rail.es.json'
import ptPreferencias from './preferencias.pt-BR.json'
import enPreferencias from './preferencias.en.json'
import esPreferencias from './preferencias.es.json'
import { IDIOMA_PADRAO, IDIOMAS, type Idioma } from './idioma'

/**
 * O REGISTRO de catálogos: qual texto sai em qual idioma.
 *
 * ## Por que os três idiomas são importados de uma vez
 *
 * Porque o adendo pede que os catálogos funcionem **offline** e sem custo por
 * tradução em uso. Importados estaticamente, eles entram no pacote, a troca de
 * idioma é síncrona e não existe o "flash de idioma incorreto" que uma busca
 * assíncrona produz no primeiro render. Os três catálogos migrados somam poucos
 * quilobytes; se um dia isso pesar, a resposta é dividir por rota — e não
 * traduzir em tempo de execução.
 *
 * ## Por que não instalamos uma biblioteca de i18n
 *
 * **DECISÃO ASSUMIDA:** a camada que já existe é um objeto por espaço de nomes,
 * importado e lido por caminho. O que faltava não era um motor de tradução — era
 * a SEGUNDA e a TERCEIRA coluna. Trocar a camada por uma biblioteca obrigaria a
 * reescrever cinquenta sítios de leitura para ganhar recursos que este produto
 * não usa (carregamento remoto, detecção por IP, tradução em tempo real), e o
 * adendo proíbe justamente esses. Justificativa registrada aqui porque a próxima
 * pessoa vai perguntar.
 *
 * ## O que é migrado, e o que ainda não é
 *
 * Só o que está NESTE arquivo está em três idiomas. Os outros onze catálogos da
 * interface e os dezenove dos plugins continuam em português, e continuam sendo
 * importados direto por quem os usa. Isso é declarado na tela, em vez de a
 * interface fingir estar traduzida e cair em português no meio de uma frase.
 */

/** Um espaço de nomes traduzido, com os três idiomas. */
export type EspacoDeNomes = 'rail' | 'preferencias'

/** A forma de um catálogo: o do português é a referência. */
export interface Catalogos {
  readonly rail: typeof ptRail
  readonly preferencias: typeof ptPreferencias
}

/*
  O tipo de CADA idioma é o do português.

  Isso é o que faz uma chave faltando no inglês virar erro de compilação, e não
  um `undefined` que a tela desenha como a palavra "undefined" no meio de um
  botão. `gate:i18n` confere o resto — chaves a mais, interpolação e plural.
*/
const REGISTRO: Readonly<Record<Idioma, Catalogos>> = {
  'pt-BR': { rail: ptRail, preferencias: ptPreferencias },
  en: { rail: enRail, preferencias: enPreferencias },
  es: { rail: esRail, preferencias: esPreferencias },
}

/**
 * Os catálogos de um idioma.
 * @param idioma - o idioma efetivo.
 * @returns os catálogos daquele idioma.
 */
export function catalogosDe(idioma: Idioma): Catalogos {
  return REGISTRO[idioma] ?? REGISTRO[IDIOMA_PADRAO]
}

/** Os espaços de nomes que já estão nos três idiomas. */
export const ESPACOS_TRADUZIDOS: readonly EspacoDeNomes[] = ['rail', 'preferencias']

/**
 * A TELA de cada espaço de nomes traduzido, a partir de `apps/studio-web/src`.
 *
 * Existe porque um catálogo traduzido não prova uma tela traduzida. A revisão de
 * 18/09/2026 achou o contrário disto: `rail` estava nos três idiomas e o rótulo
 * acessível do logotipo saía em português, porque vinha de uma FUNÇÃO — e uma
 * função não aparece em varredura de texto nem em conferência de catálogo.
 *
 * `gate:idiomas` percorre o grafo de importações a partir daqui e cobra, nos
 * módulos alcançados, o que nenhum catálogo consegue cobrar: idioma fixo escrito
 * no código. Declarar a tela junto do espaço de nomes faz a cobertura CRESCER
 * sozinha — migrar um espaço obriga a apontar a tela dele, e a tela entra na
 * varredura no mesmo dia.
 */
export const TELAS_TRADUZIDAS: Readonly<Record<EspacoDeNomes, readonly string[]>> = {
  rail: ['shell/Rail.tsx'],
  preferencias: ['preferencias/Preferencias.tsx'],
}

/**
 * Quantos idiomas o produto serve de verdade.
 *
 * Existe como função para que a tela nunca escreva "3" à mão: um idioma novo
 * entra em `IDIOMAS` e a tela acompanha sozinha.
 * @returns a contagem.
 */
export function quantosIdiomas(): number {
  return IDIOMAS.length
}
