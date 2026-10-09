import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * O DOCTOR DA PRIMEIRA EXECUÇÃO.
 *
 * O README diz que este produto existe porque as outras ferramentas, quando
 * algo dá errado, mostram um *stack trace*. E a primeira execução do Studio
 * mostrava exatamente isto:
 *
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/dsh-app-boot'
 *       at Object.getPackageJSONURL (node:internal/modules/package_json_reader:314:9)
 *
 * Oito linhas de pilha do Node para dizer uma coisa que cabe numa frase: *o
 * Harness ainda não foi instalado*. A promessa do produto quebrava antes da
 * primeira tela.
 *
 * Este arquivo é PURO de propósito: ele recebe o que foi observado do disco e
 * devolve o veredito. Quem olha o disco é `studio-start.mjs`. A separação não é
 * estética — é o que permite provar cada resposta sem precisar de uma máquina
 * naquele estado, e é a mesma lição que esta missão aprendeu seis vezes: se a
 * decisão importa, ela não mora na montagem.
 *
 * REGRA DE OURO DAS FRASES: toda linha que a pessoa lê termina no que ela deve
 * fazer. Um diagnóstico que diz o que está errado e não diz o próximo passo
 * transfere o problema em vez de resolvê-lo — e quem recebe não programa.
 */

/** O que uma conferência pode devolver. */
export const ESTADOS = ['OK', 'FALTA', 'NAO_SEI']

/**
 * Uma conferência: o que foi olhado, o que se viu, e o que fazer.
 *
 * `NAO_SEI` existe pelo mesmo motivo do registro de capacidades: "não consegui
 * olhar" é uma resposta diferente de "está faltando", e juntá-las mandaria a
 * pessoa consertar algo que talvez esteja certo.
 */

/**
 * As conferências, na ordem em que importam.
 *
 * A ORDEM É A DA CAUSA, e não a da gravidade: instalar o Studio antes do
 * Harness não adianta, então o Harness vem primeiro. Uma lista ordenada por
 * gravidade faria a pessoa começar pelo passo que ainda não pode dar.
 *
 * `bloqueia: true` quer dizer que o Studio NÃO SOBE sem isso. `false` quer
 * dizer que ele sobe e alguma coisa não vai funcionar — e a diferença tem de
 * chegar à tela, porque "não abre" e "abre e não cria aplicativo" mandam a
 * pessoa fazer coisas diferentes.
 */
export function conferencias(observado) {
  const lista = []

  lista.push({
    id: 'node',
    titulo: 'A versão do Node.js',
    ...avaliarNode(observado.nodeVersion, observado.nodeEsperado),
    bloqueia: true,
  })

  lista.push({
    id: 'submodulo',
    titulo: 'O Harness fixado, baixado',
    ...(observado.submoduloPresente
      ? { estado: 'OK', viu: 'o Harness está no lugar' }
      : {
        estado: 'FALTA',
        viu: 'a pasta do Harness está vazia',
        porque: 'O Studio é construído SOBRE o Harness. Sem ele não há o que iniciar.',
        faca: 'git submodule update --init --recursive',
      }),
    bloqueia: true,
  })

  lista.push({
    id: 'harness-instalado',
    titulo: 'As dependências do Harness',
    ...(observado.harnessInstalado
      ? { estado: 'OK', viu: 'instaladas' }
      : {
        estado: 'FALTA',
        viu: 'não instaladas',
        porque: 'O Harness precisa das próprias dependências antes de qualquer outra coisa.',
        faca: 'pnpm --dir third_party/deepseek-harness install --frozen-lockfile',
      }),
    bloqueia: true,
  })

  lista.push({
    id: 'harness-compilado',
    titulo: 'O Harness compilado',
    ...(observado.harnessCompilado
      ? { estado: 'OK', viu: 'compilado' }
      : {
        estado: 'FALTA',
        viu: 'não compilado',
        porque: 'Os pacotes do Harness são dependências do Studio, e ele lê os arquivos já compilados.',
        faca: 'pnpm --dir third_party/deepseek-harness build:official',
      }),
    bloqueia: true,
  })

  lista.push({
    id: 'arranque',
    titulo: 'O pacote que dá a partida',
    ...(observado.arranqueResolvivel
      ? { estado: 'OK', viu: 'encontrado' }
      : {
        estado: 'FALTA',
        viu: 'não encontrado',
        // Esta é A conferência que existia para ser escrita. Sem ela, o que a
        // pessoa via era `ERR_MODULE_NOT_FOUND` e oito linhas de pilha.
        porque: 'Sem ele o Studio não tem por onde começar, e o erro que aparece é uma mensagem interna do Node.',
        // O pacote que dá a partida é o `dsh` do Harness FIXADO (ver
        // `binDoHarness`), e quem o prepara são os dois passos do Harness no
        // BOOTSTRAP. Mandar rodar o `install` do Studio aqui era mandar a
        // pessoa repetir, em laço, um comando que não resolve isto.
        faca: 'pnpm --dir third_party/deepseek-harness build:official',
      }),
    bloqueia: true,
  })

  lista.push({
    id: 'studio-instalado',
    titulo: 'As dependências do Studio',
    ...(observado.studioInstalado
      ? { estado: 'OK', viu: 'instaladas' }
      : {
        estado: 'FALTA',
        viu: 'não instaladas',
        porque: 'São os vinte componentes que formam o Studio.',
        faca: "pnpm install --frozen-lockfile --filter '@dz23-studio/*...'",
      }),
    bloqueia: true,
  })

  lista.push({
    id: 'studio-compilado',
    titulo: 'O Studio compilado',
    ...(observado.studioCompilado
      ? { estado: 'OK', viu: 'compilado' }
      : {
        estado: 'FALTA',
        viu: 'não compilado',
        porque: 'O Studio roda a partir do que foi compilado, e não do código-fonte.',
        faca: 'pnpm build',
      }),
    bloqueia: true,
  })

  lista.push({
    id: 'perfil',
    titulo: 'O perfil do Studio',
    ...(observado.perfilPresente
      ? { estado: 'OK', viu: 'no lugar' }
      : {
        estado: 'FALTA',
        viu: 'não encontrado',
        porque: 'É o arquivo que diz ao Harness quais componentes do Studio carregar.',
        faca: 'Confira se a pasta dsh-home/profiles/studio existe no seu clone.',
      }),
    bloqueia: true,
  })

  // A partir daqui, NADA bloqueia o arranque. O Studio sobe, abre no navegador,
  // e diz na própria tela o que ainda não consegue fazer — é para isso que o
  // registro de capacidades existe. Bloquear aqui impediria a pessoa de ver o
  // produto por causa de algo que ela conserta depois, de dentro dele.
  lista.push({
    id: 'construtor',
    titulo: 'O ambiente isolado de criação',
    ...avaliarConstrutor(observado.docker),
    bloqueia: false,
  })

  lista.push({
    id: 'modelo',
    titulo: 'A inteligência artificial',
    ...avaliarModelo(observado.rotasConfiguradas),
    bloqueia: false,
  })

  return lista
}

/**
 * A versão do Node.
 *
 * DUAS respostas diferentes, porque são dois riscos diferentes.
 *
 * Versão MAIOR diferente (o 22 contra o 20) quebra de verdade, e bloqueia.
 *
 * Versão menor diferente dentro da mesma linha NÃO bloqueia — ela é DITA e o
 * Studio abre. Recusar o Node 22.22 porque a prova foi feita no 22.23 impediria
 * a pessoa de usar o produto por causa de uma diferença que ela não tem como
 * julgar, e que quase certamente não a afeta. Mas esconder a diferença também
 * seria errado: se algo estranho acontecer, essa linha é a primeira coisa que
 * alguém vai querer saber.
 */
function avaliarNode(atual, esperado) {
  if (atual === undefined) return { estado: 'NAO_SEI', viu: 'não foi possível ler a versão' }
  // Sem versão fixada não há contra o que comparar, e inventar uma faria o
  // doctor recusar um ambiente correto.
  if (esperado === undefined) return { estado: 'OK', viu: atual }
  const maior = versao => versao.replace(/^v/u, '').split('.')[0]
  if (maior(atual) !== maior(esperado)) {
    return {
      estado: 'FALTA',
      viu: `${atual}, e o Studio precisa do Node ${maior(esperado)}`,
      porque: 'Versões maiores diferentes do Node mudam o comportamento de coisas que o Studio usa.',
      faca: `Instale o Node ${esperado}.`,
    }
  }
  const igual = versao => versao.replace(/^v/u, '')
  if (igual(atual) !== igual(esperado)) return { estado: 'OK', viu: `${atual} (o Studio foi provado com ${esperado})` }
  return { estado: 'OK', viu: atual }
}

function avaliarConstrutor(docker) {
  if (docker === undefined) return { estado: 'NAO_SEI', viu: 'não foi possível perguntar' }
  if (docker) return { estado: 'OK', viu: 'respondendo' }
  return {
    estado: 'FALTA',
    viu: 'não respondeu',
    porque: 'O Studio constrói cada aplicativo dentro de um contêiner sem rede. Sem isso ele abre, mas não cria.',
    faca: 'Abra o Docker Desktop, ou instale o Docker.',
  }
}

/**
 * As TRES rotas do perfil (ADR-014), pela ordem em que alguem deveria pensar
 * nelas.
 *
 * A ordem e a da PRIVACIDADE, e nao a da qualidade: a rota local nao manda o
 * texto de ninguem para lugar nenhum, e por isso ela e a primeira que a pessoa
 * ve. Quem quiser as outras escolhe de olho aberto.
 *
 * `chave` e o NOME da variavel de ambiente, nunca o valor — que e a mesma regra
 * do perfil: chaves sao referencias, e nenhum segredo entra em arquivo gerado,
 * log, pacote ou tela.
 */
export const ROTAS = [
  {
    id: 'ollama',
    nome: 'Ollama, no seu computador',
    chave: undefined,
    endereco: 'DZ23_OLLAMA_BASE_URL',
    nota: 'Não manda o seu texto para fora. Precisa do Ollama rodando.',
  },
  {
    id: 'deepseek-official',
    nome: 'DeepSeek oficial',
    chave: 'DEEPSEEK_API_KEY',
    endereco: undefined,
    nota: 'A rota padrão, e a única para a qual o Studio volta sozinho quando outra falha antes de escrever qualquer coisa.',
  },
  {
    id: 'omniroute',
    nome: 'OmniRoute (externo, opcional, avançado)',
    chave: 'DZ23_OMNIROUTE_KEY',
    endereco: 'DZ23_OMNIROUTE_BASE_URL',
    // Os limites do OmniRoute são de ADR, e não de gosto: ele é EXTERNO,
    // OPCIONAL, AVANÇADO e DESLIGADO por padrão; consome somente `/v1`; e
    // nunca fica ativo ao mesmo tempo que o 9Router, que não integra o perfil.
    // Sem chave configurada ele simplesmente não existe para o Studio — e é
    // por isso que esta conferência olha a variável, e não a declaração no
    // perfil, que está sempre lá.
    nota: 'Desligada por padrão. Só entra quando você configura a chave, e nunca junto com o 9Router.',
  },
]

/**
 * Quais rotas estao configuradas, a partir do AMBIENTE.
 *
 * Estar declarada no perfil nao e estar configurada: as tres estao sempre
 * declaradas, e dizer "tres configuradas" com o ambiente vazio seria a mesma
 * mentira confortavel que o registro de capacidades existe para nao contar.
 *
 * O Ollama e o unico sem chave: ele nao tem segredo nenhum, e por isso conta
 * como configurado quando o endereco dele foi apontado. Sem endereco apontado o
 * perfil usa `127.0.0.1:11434`, e se ha um Ollama ali o Studio o encontra — mas
 * quem ESCREVE esse endereco esta dizendo que sabe onde ele esta, e e isso que
 * esta conferencia consegue afirmar sem abrir uma conexao.
 * @param ambiente - as variaveis de ambiente.
 * @returns a lista das rotas configuradas, por id.
 */
export function rotasConfiguradas(ambiente) {
  if (ambiente === undefined) return undefined
  const posta = nome => nome !== undefined && typeof ambiente[nome] === 'string' && ambiente[nome].trim() !== ''
  return ROTAS.filter(rota => posta(rota.chave) || posta(rota.endereco)).map(rota => rota.id)
}

/**
 * A inteligencia artificial.
 *
 * NOMEIA as rotas em vez de contar quantas: "duas configuradas" nao diz a
 * ninguem se o texto dele vai sair do computador, e essa e a unica coisa que
 * alguem realmente quer saber aqui.
 */
function avaliarModelo(rotas) {
  if (rotas === undefined) return { estado: 'NAO_SEI', viu: 'não foi possível perguntar' }
  const nomes = ROTAS.filter(rota => rotas.includes(rota.id)).map(rota => rota.nome)
  if (nomes.length > 0) return { estado: 'OK', viu: nomes.join('; ') }
  return {
    estado: 'FALTA',
    viu: 'nenhuma configurada',
    porque: 'É ela que escreve o plano e o código. Sem ela o Studio abre, mas não passa da primeira tela.',
    faca: 'Configure uma inteligência artificial na tela de ajuste do Studio, depois que ele abrir.',
  }
}

/** As conferências que impedem o arranque. */
export function bloqueios(lista) {
  return lista.filter(item => item.bloqueia && item.estado === 'FALTA')
}

/**
 * A conferência que a pessoa deve resolver PRIMEIRO.
 *
 * Uma só, e não a lista inteira. Mostrar oito coisas faltando de uma vez para
 * quem não programa é a mesma paralisia que o stack trace causava — e, como a
 * ordem é a da causa, resolver a primeira quase sempre resolve as seguintes.
 */
export function primeiroPasso(lista) {
  return bloqueios(lista)[0]
}

/** O que o Studio vai abrir sem conseguir fazer. */
export function avisos(lista) {
  return lista.filter(item => !item.bloqueia && item.estado !== 'OK')
}

/**
 * O relatório inteiro, em texto.
 *
 * Ele é devolvido como TEXTO e não impresso aqui: uma função que imprime não
 * pode ser conferida sem capturar a saída do processo, e o que esta missão
 * inteira aprendeu é que o que não se consegue conferir é o que quebra calado.
 */
/**
 * As frases de fechamento do relatório, por assunto.
 *
 * Elas são PARÂMETRO desde 19/09/2026, quando o conferidor do construtor
 * nasceu: ele responde a outra pergunta ("dá para construir aqui?") e precisava
 * das mesmas quatro marcas, da mesma ordem-por-causa e do mesmo "termine no
 * próximo comando". Copiar o renderizador para trocar três frases teria criado
 * duas descrições do mesmo formato, e elas divergiriam no primeiro conserto de
 * uma delas.
 */
export const ASSUNTO_DO_STUDIO = Object.freeze({
  bloqueado: 'O Studio ainda não pode abrir. Falta isto:',
  repetir: 'Depois rode `pnpm studio` de novo.',
  abreMasFalta: 'O Studio vai abrir. Mas ainda falta isto para ele criar um aplicativo:',
})

export function relatorio(lista, assunto = ASSUNTO_DO_STUDIO) {
  const linhas = []
  for (const item of lista) {
    // Quatro marcas, e nao tres. Um `>>>` num item que NAO bloqueia poria, na
    // mesma coluna, uma linha explicada logo abaixo e outra que a pessoa nao
    // tem o que fazer agora — e ela leria as duas como o mesmo impedimento.
    const marca = item.estado === 'OK' ? '  ok ' : item.estado === 'NAO_SEI' ? '  ?  ' : item.bloqueia ? ' >>> ' : '  !  '
    linhas.push(`${marca}${item.titulo}: ${item.viu}`)
  }
  const passo = primeiroPasso(lista)
  if (passo !== undefined) {
    linhas.push('')
    linhas.push(`${assunto.bloqueado} ${passo.titulo.toLowerCase()}.`)
    if (passo.porque !== undefined) linhas.push(passo.porque)
    linhas.push('')
    linhas.push('Rode este comando:')
    linhas.push(`  ${passo.faca}`)
    const restantes = bloqueios(lista).length - 1
    if (restantes > 0) {
      linhas.push('')
      linhas.push(`${assunto.repetir} Ainda faltam outros ${String(restantes)} passo(s), e eles aparecem um por vez.`)
    }
    return linhas.join('\n')
  }
  const pendentes = avisos(lista)
  if (pendentes.length > 0) {
    linhas.push('')
    linhas.push(assunto.abreMasFalta)
    for (const item of pendentes) {
      linhas.push(`  - ${item.titulo}: ${item.viu}. ${item.faca ?? ''}`.trimEnd())
    }
  }
  return linhas.join('\n')
}

/**
 * Lê a versão do Node com que este produto foi provado.
 *
 * Ela vem do `.nvmrc` quando ele existe, porque é o arquivo que as ferramentas
 * de versão já leem. AUSENTE devolve `undefined`, e `undefined` vira `NAO_SEI`
 * — nunca um número inventado, que faria o doctor recusar um ambiente correto.
 */
export function versaoEsperada(raiz) {
  const caminho = resolve(raiz, '.nvmrc')
  if (!existsSync(caminho)) return undefined
  const conteudo = readFileSync(caminho, 'utf8').trim()
  return conteudo.length === 0 ? undefined : conteudo.replace(/^v/u, '')
}
