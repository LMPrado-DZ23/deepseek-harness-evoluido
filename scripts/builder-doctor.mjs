#!/usr/bin/env node
/**
 * O CONFERIDOR DO CONSTRUTOR — "dá para construir um aplicativo nesta máquina?"
 *
 * ## Por que ele existe
 *
 * Em 18/09/2026 a jornada real chegou até o plano aprovado e parou: `POST
 * /generate` devolve `202` e a execução vai a `BLOCKED_EXTERNAL` no passo
 * `build`, em zero milissegundo, porque o supervisor de construção não está
 * provisionado. Descobrir POR QUÊ custou uma tarde de medições à mão em duas
 * máquinas — cliente e daemon do Docker, arquitetura, espaço, saída de rede,
 * submódulo, sistema de arquivos. Nenhuma delas ficou sendo comando.
 *
 * Este arquivo transforma aquelas medições numa pergunta que qualquer pessoa
 * faz de novo, em qualquer máquina, e que responde SEMPRE terminando no próximo
 * comando. Ele não instala nada e não muda nada: olha, e diz.
 *
 * ## O que ele mediu e por que a resposta importava
 *
 * As duas máquinas tinham METADE do que a construção precisa, e a metade era
 * diferente em cada uma: no contêiner desta sessão há rede e Docker, e falta
 * disco; no WSL2 do titular há 880 GB e Docker, e não há saída na porta 443.
 * A conclusão "falta disco" estava certa num lugar e errada no outro — e é
 * exatamente esse tipo de conclusão que um conferidor impede.
 *
 * ## O que ele NÃO faz
 *
 * Não constrói a imagem, não provisiona, não sobe serviço. O instalador
 * reproduzível ainda não existe, e ele diz isso com todas as letras em vez de
 * fingir que o passo seguinte é óbvio.
 *
 * Uso: node scripts/builder-doctor.mjs [--self-test]
 */
import { existsSync, statfsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { relatorio, bloqueios } from './studio-doctor.mjs'

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** As frases de fechamento deste conferidor. */
export const ASSUNTO_DO_CONSTRUTOR = Object.freeze({
  bloqueado: 'O FRIGG ainda não consegue construir aqui. Falta isto:',
  repetir: 'Depois rode `pnpm builder:doctor` de novo.',
  abreMasFalta: 'A construção pode começar. Mas isto ainda vai faltar na jornada:',
})

/** As arquiteturas que a imagem do construtor declara. */
export const ARQUITETURAS = Object.freeze(['x64', 'arm64'])

/**
 * O espaço ESTIMADO para construir a imagem, em gigabytes.
 *
 * ESTIMATIVA, e não medição — e a diferença está escrita na resposta que a
 * pessoa lê. Ninguém aqui construiu a imagem ainda: o número vem da soma
 * declarada da base (`mcr.microsoft.com/playwright`, ~4 GB descompactada), do
 * Node e do pnpm baixados dentro dela e das duas árvores de dependências que o
 * `pnpm fetch` materializa. Um conferidor que afirmasse "8 GB bastam" estaria
 * prometendo o que não mediu; este diz que abaixo disso é improvável e por quê.
 */
export const ESPACO_ESTIMADO_GB = 8

/** Os endereços que o build da imagem precisa alcançar. */
export const ENDERECOS_DO_BUILD = Object.freeze([
  'https://mcr.microsoft.com/v2/',
  'https://nodejs.org/dist/',
  'https://registry.npmjs.org/',
])

/**
 * As conferências do construtor, a partir do que foi observado.
 *
 * A ORDEM É A DA CAUSA, como no conferidor do Studio: sem cliente não há
 * daemon, sem daemon não há imagem, e a rede só bloqueia enquanto a imagem não
 * estiver na máquina — quem já tem a imagem não precisa de registro nenhum.
 * @param observado - o que foi lido da máquina.
 * @returns a lista de conferências.
 */
export function conferenciasDoConstrutor(observado) {
  const lista = []
  lista.push({
    id: 'docker-cliente',
    titulo: 'O Docker instalado',
    ...(observado.dockerCliente === undefined
      ? { estado: 'NAO_SEI', viu: 'não foi possível perguntar' }
      : observado.dockerCliente
        ? { estado: 'OK', viu: observado.dockerVersao ?? 'instalado' }
        : {
          estado: 'FALTA', viu: 'não encontrado',
          porque: 'Cada aplicativo é construído dentro de um contêiner isolado, e quem cria o contêiner é o Docker.',
          faca: 'Instale o Docker (no Windows, o Docker Desktop com a integração do WSL2 ligada).',
        }),
    bloqueia: true,
  })
  lista.push({
    id: 'docker-daemon',
    titulo: 'O Docker respondendo',
    ...(observado.dockerDaemon === true
      ? { estado: 'OK', viu: observado.dockerServidor ?? 'respondendo' }
      : observado.dockerDaemon === undefined
        ? { estado: 'NAO_SEI', viu: 'não foi possível perguntar' }
        : {
          estado: 'FALTA', viu: 'instalado, e não está no ar',
          porque: 'O cliente do Docker existe nesta máquina, mas ninguém está atendendo — construir precisa do serviço rodando.',
          faca: 'Abra o Docker Desktop, ou inicie o serviço do Docker nesta máquina.',
        }),
    bloqueia: true,
  })
  lista.push({
    id: 'arquitetura',
    titulo: 'A arquitetura desta máquina',
    ...(observado.arquitetura === undefined
      ? { estado: 'NAO_SEI', viu: 'não foi possível perguntar' }
      : ARQUITETURAS.includes(observado.arquitetura)
        ? { estado: 'OK', viu: observado.arquitetura }
        : {
          estado: 'FALTA', viu: `${String(observado.arquitetura)}, e a imagem do construtor não a declara`,
          porque: 'A imagem só resolve Node para x64 e arm64; qualquer outra recusa na hora do build.',
          faca: 'Use uma máquina x64 ou arm64 para construir.',
        }),
    bloqueia: true,
  })
  // A imagem vem ANTES da rede de propósito: quem já a tem não precisa de
  // registro nenhum, e dizer "falta rede" a essa pessoa seria mandá-la resolver
  // o que não a impede.
  lista.push({
    id: 'imagem',
    titulo: 'A imagem do construtor',
    ...(observado.imagemPresente === true
      ? { estado: 'OK', viu: observado.imagemReferencia ?? 'presente nesta máquina' }
      : {
        estado: 'FALTA', viu: 'não está nesta máquina',
        porque: 'É ela que roda o código gerado sem rede, com o sistema de arquivos somente leitura e sem permissão de sistema.',
        faca: 'Construa-a a partir de `deploy/builder/Dockerfile` — e note que ela ainda não tem um instalador reproduzível (ABRIR-05).',
      }),
    bloqueia: true,
  })
  lista.push({
    id: 'espaco',
    titulo: 'O espaço em disco',
    ...(observado.espacoLivreGb === undefined
      ? { estado: 'NAO_SEI', viu: 'não foi possível medir' }
      : observado.imagemPresente === true || observado.espacoLivreGb >= ESPACO_ESTIMADO_GB
        ? { estado: 'OK', viu: `${String(observado.espacoLivreGb)} GB livres${ondeMediu(observado)}` }
        : {
          estado: 'FALTA', viu: `${String(observado.espacoLivreGb)} GB livres${ondeMediu(observado)}, e a estimativa é ${String(ESPACO_ESTIMADO_GB)} GB`,
          porque: 'A estimativa NÃO é medição: ninguém construiu esta imagem ainda. Ela soma a base declarada, o Node, o pnpm e as duas árvores de dependências.',
          faca: 'Libere espaço no disco onde o Docker guarda as imagens, ou construa em outra máquina.',
        }),
    bloqueia: true,
  })
  lista.push({
    id: 'rede',
    titulo: 'A saída de rede para construir a imagem',
    ...(observado.imagemPresente === true
      ? { estado: 'OK', viu: 'a imagem já está aqui; nada a baixar' }
      : observado.redeAlcancavel === undefined
        ? { estado: 'NAO_SEI', viu: 'não foi possível perguntar' }
        : observado.redeAlcancavel
          ? { estado: 'OK', viu: 'os três endereços do build respondem' }
          : {
            estado: 'FALTA', viu: `sem resposta em ${(observado.redeBloqueada ?? []).join(', ') || 'nenhum endereço'}`,
            porque: 'O build baixa a imagem base, o Node e o pnpm. Sem saída na porta 443 ele para no primeiro passo.',
            faca: 'Libere a saída HTTPS desta máquina, ou traga a imagem pronta por um caminho autorizado.',
          }),
    bloqueia: true,
  })
  lista.push({
    id: 'submodulo',
    titulo: 'O Harness fixado, baixado',
    ...(observado.submoduloPresente === true
      ? { estado: 'OK', viu: 'no lugar' }
      : {
        estado: 'FALTA', viu: 'a pasta existe e está vazia',
        porque: 'O produto é construído SOBRE o Harness fixado; sem ele nem o Studio sobe, quanto mais a construção.',
        faca: 'git submodule update --init --recursive',
      }),
    bloqueia: true,
  })
  lista.push({
    id: 'sistema-de-arquivos',
    titulo: 'O sistema de arquivos deste clone',
    ...(observado.sistemaDeArquivos === undefined
      ? { estado: 'NAO_SEI', viu: 'não foi possível perguntar' }
      : observado.sistemaDeArquivosSuportado
        ? { estado: 'OK', viu: observado.sistemaDeArquivos }
        : {
          estado: 'FALTA', viu: `${observado.sistemaDeArquivos}, e o provisionamento recusa`,
          porque: 'O provisionamento do construtor exige ext4 ou XFS e falha fechado em /mnt/*, NFS, CIFS, FUSE e btrfs — está escrito no README do supervisor.',
          faca: 'Clone o projeto num disco ext4 (no WSL2, dentro de ~, nunca em /mnt/c).',
        }),
    bloqueia: true,
  })
  lista.push({
    id: 'instalador',
    titulo: 'O instalador reproduzível do construtor',
    ...(observado.instaladorPresente === true
      ? { estado: 'OK', viu: 'existe' }
      : {
        estado: 'FALTA', viu: 'ainda não existe',
        porque: 'O `provision-cli` provisiona a configuração, e o README diz com todas as letras que ele NÃO cria as raízes de policy, não materializa o volume do template store e não torna o serviço ativo.',
        faca: 'É trabalho de engenharia, e está registrado como ABRIR-05 no DAG.',
      }),
    bloqueia: true,
  })
  lista.push({
    id: 'modelo',
    titulo: 'A inteligência artificial',
    ...(observado.modeloAlcancavel === true
      ? { estado: 'OK', viu: 'uma rota respondeu' }
      : observado.modeloAlcancavel === undefined
        ? { estado: 'NAO_SEI', viu: 'não foi possível perguntar' }
        : { estado: 'FALTA', viu: 'nenhuma rota respondeu', faca: 'Configure a rota local ou uma credencial de provedor antes da jornada.' }),
    // NÃO bloqueia: construir é uma coisa, gerar é outra. Um construtor pronto
    // sem modelo é um construtor pronto.
    bloqueia: false,
  })
  return lista
}

/**
 * O trecho que diz ONDE o espaço foi medido.
 * @param observado - o observado.
 * @returns o trecho, ou vazio quando não se sabe.
 */
function ondeMediu(observado) {
  return observado.espacoMedidoEm === undefined ? '' : ` em ${observado.espacoMedidoEm}`
}

/** Uma sonda que não toca em rede nem em processo — o padrão é o disco real. */
export const SONDA_DO_CONSTRUTOR = {
  docker() {
    const versao = spawnSync('docker', ['--version'], { encoding: 'utf8', timeout: 10_000 })
    if (versao.status !== 0) return { cliente: false }
    const info = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}|{{.DockerRootDir}}'], { encoding: 'utf8', timeout: 20_000 })
    const [servidor, raizDoDocker] = info.status === 0 ? info.stdout.trim().split('|') : []
    return {
      cliente: true,
      versao: versao.stdout.trim(),
      daemon: info.status === 0 && (servidor ?? '') !== '',
      servidor,
      raiz: raizDoDocker === '' ? undefined : raizDoDocker,
    }
  },
  espacoLivreGb(caminho) {
    try {
      const { bavail, bsize } = statfsSync(caminho)
      return Math.floor((Number(bavail) * Number(bsize)) / 1024 ** 3)
    } catch { return undefined }
  },
  sistemaDeArquivos(caminho) {
    const saida = spawnSync('df', ['--output=fstype', caminho], { encoding: 'utf8', timeout: 10_000 })
    if (saida.status !== 0) return undefined
    return saida.stdout.trim().split('\n').at(-1)?.trim()
  },
  async rede(enderecos) {
    const bloqueados = []
    for (const endereco of enderecos) {
      try {
        const controle = AbortSignal.timeout(8_000)
        await fetch(endereco, { method: 'HEAD', signal: controle })
      } catch { bloqueados.push(new URL(endereco).host) }
    }
    return bloqueados
  },
  async modelo(endereco) {
    try {
      const resposta = await fetch(endereco, { signal: AbortSignal.timeout(5_000) })
      return resposta.ok
    } catch { return false }
  },
}

/**
 * O espaço livre ONDE AS IMAGENS MORAM, e onde ele foi medido.
 *
 * A primeira versão media no disco do CLONE, e errou na máquina do titular: o
 * clone está em `/mnt/c` (o disco do Windows, 203 GB livres) e as imagens do
 * Docker moram na raiz do daemon, no ext4 do WSL2 (880 GB). A resposta estava
 * certa por acaso e sobre o disco errado — o tipo de acerto que vira erro no
 * primeiro lugar onde os dois discos divergem.
 *
 * A raiz do daemon costuma ser de uso exclusivo do administrador, e a leitura
 * pode ser recusada. Aí mede-se o diretório de cima, e a resposta DIZ que foi
 * ali. Sem raiz nenhuma para medir, a resposta é "não sei" — nunca o disco do
 * clone fingindo ser o das imagens.
 * @param raizDoDocker - `DockerRootDir`, quando o daemon respondeu.
 * @param sonda - de onde vem a medida.
 * @returns o espaço em GB e o caminho medido, ou nada.
 */
export function espacoOndeAsImagensMoram(raizDoDocker, sonda) {
  if (raizDoDocker === undefined) return {}
  for (const caminho of [raizDoDocker, dirname(raizDoDocker)]) {
    const espaco = sonda.espacoLivreGb(caminho)
    if (espaco !== undefined) return { espacoLivreGb: espaco, espacoMedidoEm: caminho }
  }
  return {}
}

/** Os sistemas de arquivos que o provisionamento aceita. */
export const SISTEMAS_SUPORTADOS = Object.freeze(['ext4', 'xfs'])

/**
 * Olha a máquina.
 * @param base - a raiz do repositório.
 * @param sonda - de onde vêm as respostas.
 * @returns o observado, pronto para `conferenciasDoConstrutor`.
 */
export async function observarConstrutor(base = raiz, sonda = SONDA_DO_CONSTRUTOR) {
  const docker = sonda.docker()
  const imagem = spawnSync('docker', ['image', 'inspect', 'dz23-studio/builder:local'], { encoding: 'utf8', timeout: 15_000 })
  const sistema = sonda.sistemaDeArquivos(base)
  const bloqueados = await sonda.rede(ENDERECOS_DO_BUILD)
  return {
    dockerCliente: docker.cliente,
    dockerVersao: docker.versao,
    dockerDaemon: docker.cliente ? docker.daemon : false,
    dockerServidor: docker.servidor,
    arquitetura: process.arch,
    imagemPresente: imagem.status === 0,
    imagemReferencia: imagem.status === 0 ? 'dz23-studio/builder:local' : undefined,
    ...espacoOndeAsImagensMoram(docker.raiz, sonda),
    redeAlcancavel: bloqueados.length === 0,
    redeBloqueada: bloqueados,
    submoduloPresente: existsSync(resolve(base, 'third_party/deepseek-harness/package.json')),
    sistemaDeArquivos: sistema,
    sistemaDeArquivosSuportado: sistema === undefined ? undefined : SISTEMAS_SUPORTADOS.includes(sistema),
    // Enquanto `ABRIR-05` não entregar, esta resposta é `false` e está escrita.
    instaladorPresente: existsSync(resolve(base, 'scripts/provision-builder.mjs')),
    modeloAlcancavel: await sonda.modelo(`${process.env.DZ23_OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434/v1'}/models`),
  }
}

/** Este arquivo foi CHAMADO, ou apenas importado por um teste? */
const chamadoDiretamente = process.argv[1] !== undefined
  && import.meta.url === `file://${resolve(process.argv[1])}`

if (chamadoDiretamente && process.argv.includes('--self-test')) {
  const casos = []
  const ok = (nome, condicao) => { casos.push(condicao); if (!condicao) console.error(`  autoteste FALHOU: ${nome}`) }
  const pronto = {
    dockerCliente: true, dockerDaemon: true, arquitetura: 'x64', imagemPresente: true, espacoLivreGb: 2,
    redeAlcancavel: false, redeBloqueada: ['mcr.microsoft.com'], submoduloPresente: true,
    sistemaDeArquivos: 'ext4', sistemaDeArquivosSuportado: true, instaladorPresente: true, modeloAlcancavel: true,
  }
  const verde = conferenciasDoConstrutor(pronto)
  ok('com a imagem presente, rede e espaco NAO bloqueiam', bloqueios(verde).length === 0)
  ok('sem daemon, bloqueia', bloqueios(conferenciasDoConstrutor({ ...pronto, dockerDaemon: false })).length === 1)
  ok('sem imagem e sem rede, bloqueia os dois',
    bloqueios(conferenciasDoConstrutor({ ...pronto, imagemPresente: false })).map(item => item.id).join(',') === 'imagem,espaco,rede')
  ok('sem imagem e com rede, so a imagem bloqueia',
    bloqueios(conferenciasDoConstrutor({ ...pronto, imagemPresente: false, espacoLivreGb: 50, redeAlcancavel: true })).map(item => item.id).join(',') === 'imagem')
  ok('em /mnt/c, bloqueia', bloqueios(conferenciasDoConstrutor({ ...pronto, sistemaDeArquivos: '9p', sistemaDeArquivosSuportado: false })).length === 1)
  ok('sem submodulo, bloqueia', bloqueios(conferenciasDoConstrutor({ ...pronto, submoduloPresente: false })).length === 1)
  ok('sem instalador, bloqueia', bloqueios(conferenciasDoConstrutor({ ...pronto, instaladorPresente: false })).length === 1)
  ok('sem modelo, NAO bloqueia', bloqueios(conferenciasDoConstrutor({ ...pronto, modeloAlcancavel: false })).length === 0)
  ok('o relatorio termina num comando', relatorio(conferenciasDoConstrutor({ ...pronto, submoduloPresente: false }), ASSUNTO_DO_CONSTRUTOR)
    .includes('git submodule update --init --recursive'))
  ok('o relatorio usa o assunto do construtor', relatorio(conferenciasDoConstrutor({ ...pronto, submoduloPresente: false }), ASSUNTO_DO_CONSTRUTOR)
    .includes('O FRIGG ainda não consegue construir aqui'))
  const falhas = casos.filter(caso => !caso).length
  console.log(`BUILDER_DOCTOR_SELF_TEST=${falhas === 0 ? 'PASS' : 'FAIL'} casos=${casos.length}`)
  process.exit(falhas === 0 ? 0 : 1)
}

if (chamadoDiretamente) {
  const lista = conferenciasDoConstrutor(await observarConstrutor())
  const texto = relatorio(lista, ASSUNTO_DO_CONSTRUTOR)
  if (texto.length > 0) process.stdout.write(`${texto}\n`)
  process.exit(bloqueios(lista).length > 0 ? 1 : 0)
}
