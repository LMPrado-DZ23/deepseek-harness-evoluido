/**
 * O que a Biblioteca SUPORTA — declarado, e não deduzido pela pessoa.
 *
 * A exigência é do proprietário, por escrito: "a Biblioteca precisa declarar
 * exatamente quais arquivos e operações ela suporta". O motivo é o de sempre
 * neste produto: uma tela que lista pacotes e não diz o que ela é deixa quem
 * usa supondo que dá para subir arquivo, versionar, compartilhar e apagar — e
 * a pessoa só descobre que não dá quando precisa.
 *
 * Então a lista é explícita, com as duas respostas: o que ela faz HOJE e o que
 * ela NÃO faz, cada uma com o motivo. É função pura porque essa declaração é
 * uma promessa: ela precisa de teste, e não de um parágrafo solto num JSX que
 * envelhece sem ninguém notar.
 */

export interface OperacaoDaBiblioteca {
  readonly id: string
  /** Se a Biblioteca faz isto hoje. */
  readonly suportada: boolean
  /** O motivo, quando NÃO suportada. Obrigatório nesse caso. */
  readonly motivo?: string
}

/**
 * As operações declaradas, na ordem em que a tela as mostra.
 *
 * As suportadas primeiro, porque a pergunta que a pessoa faz ao chegar é "o
 * que dá para fazer aqui".
 * @returns as operações, com a verdade de cada uma.
 */
export function operacoesDaBiblioteca(): readonly OperacaoDaBiblioteca[] {
  return [
    { id: 'listar', suportada: true },
    { id: 'filtrar', suportada: true },
    { id: 'baixar', suportada: true },
    { id: 'conferir', suportada: true },
    { id: 'preview', suportada: true },
    { id: 'enviar', suportada: false, motivo: 'semUpload' },
    { id: 'versoes', suportada: false, motivo: 'semVersao' },
    { id: 'compartilhar', suportada: false, motivo: 'semCompartilhar' },
    { id: 'apagar', suportada: false, motivo: 'semApagar' },
    { id: 'retencao', suportada: false, motivo: 'semRetencao' },
  ]
}

/**
 * Os tipos de arquivo que a Biblioteca guarda hoje.
 *
 * UM, e a tela diz qual: o pacote de exportação que uma tarefa produz. Escrever
 * "seus arquivos" no plural sugeriria que ela aceita qualquer coisa.
 * @returns os identificadores dos tipos, para a tela traduzir.
 */
export function tiposDaBiblioteca(): readonly string[] {
  return ['pacoteDeExportacao']
}
