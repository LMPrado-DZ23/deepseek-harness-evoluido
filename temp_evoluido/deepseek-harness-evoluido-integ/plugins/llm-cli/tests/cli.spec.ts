import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createUserMessage, type GenerateOptions, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  AdaptadorDeLinha, acharNoPath, ambienteSemSegredos, argumentosDaChamada, executar, FERRAMENTAS_CONHECIDAS,
  MODELO_PADRAO, procurarFerramentas, transcricao, type Execucao,
} from '../src/index.js'

const pastas: string[] = []
afterEach(async () => { await Promise.all(pastas.splice(0).map(pasta => rm(pasta, { recursive: true, force: true }))) })

async function pasta(): Promise<string> {
  const criada = await mkdtemp(join(tmpdir(), 'llm-cli-spec-'))
  pastas.push(criada)
  return criada
}

/** Um executável DE VERDADE no PATH, com o nome de uma ferramenta conhecida. */
async function ferramentaFalsa(nome: string, corpo: string): Promise<string> {
  const dir = await pasta()
  const caminho = join(dir, nome)
  await writeFile(caminho, `#!/usr/bin/env node\n${corpo}\n`)
  await chmod(caminho, 0o755)
  return dir
}

const usuario = (texto: string): Message => createUserMessage({ source: { kind: 'plugin', plugin: 't' }, content: [{ type: 'text', text: texto }] })

describe('procurar no PATH', () => {
  it('acha a primeira pasta que tem o executável, e ignora pastas vazias', () => {
    const existe = new Set(['/b/claude', '/c/claude'])
    expect(acharNoPath('claude', ['', '/a', '/b', '/c'].join(':'), caminho => existe.has(caminho))).toBe('/b/claude')
    expect(acharNoPath('claude', undefined, () => true)).toBeUndefined()
    expect(acharNoPath('claude', '/a', () => false)).toBeUndefined()
  })

  it('só registra as ferramentas instaladas, na ordem conhecida', () => {
    const achadas = procurarFerramentas('/x', caminho => caminho === '/x/gemini' || caminho === '/x/claude')
    expect(achadas.map(ferramenta => ferramenta.rota)).toEqual(['cli-claude', 'cli-gemini'])
    expect(achadas[1]!.caminho).toBe('/x/gemini')
  })

  it('usa o teste de execução real quando nenhum é dado', async () => {
    const dir = await ferramentaFalsa('qwen', '')
    await writeFile(join(dir, 'gemini'), 'sem permissão de execução')
    expect(procurarFerramentas(dir).map(ferramenta => ferramenta.rota)).toEqual(['cli-qwen'])
  })
})

describe('o que a ferramenta recebe', () => {
  it('o ambiente perde tudo que tem nome de segredo e mantém HOME e PATH', () => {
    expect(ambienteSemSegredos({ HOME: '/h', PATH: '/p', ANTHROPIC_API_KEY: 'x', GH_TOKEN: 'y', DB_PASSWORD: 'z', MY_SECRET: 'w', CREDENTIALS_FILE: 'v', VAZIO: undefined }))
      .toEqual({ HOME: '/h', PATH: '/p' })
  })

  it('uma mensagem única da pessoa vai crua; a conversa vai com papéis', () => {
    expect(transcricao({ messages: [usuario('faça X')] })).toBe('faça X')
    const conversa = transcricao({
      system: 'seja breve',
      messages: [
        usuario('oi'),
        { ...usuario(''), role: 'assistant', content: [{ type: 'reasoning', text: 'pensando' }, { type: 'text', text: 'olá' }, { type: 'tool-call', id: 'c1' as never, name: 'web_search', arguments: '{"q":"a"}' }] } as Message,
        { ...usuario(''), content: [{ type: 'tool-result', toolCallId: 'c1' as never, content: [{ type: 'text', text: 'achei' }] }] } as Message,
        { ...usuario(''), content: [{ type: 'reasoning', text: 'só raciocínio' }] } as Message,
      ],
    })
    expect(conversa).toBe('## Instruções\nseja breve\n\n## Pessoa\noi\n\n## Assistente\nolá\n[Chamada de ferramenta: web_search {"q":"a"}]\n\n## Resultado de ferramenta\nachei')
    expect(conversa).not.toContain('pensando')
  })

  it('o modelo padrão não passa --model; outro modelo passa', () => {
    const claude = FERRAMENTAS_CONHECIDAS[0]!
    expect(argumentosDaChamada(claude, MODELO_PADRAO)).toEqual(claude.argumentos)
    expect(argumentosDaChamada(claude, 'sonnet')).toEqual([...claude.argumentos, '--model', 'sonnet'])
  })

  it('cada ferramenta pede o modo sem interação e só de leitura', () => {
    const porRota = Object.fromEntries(FERRAMENTAS_CONHECIDAS.map(ferramenta => [ferramenta.rota, ferramenta.argumentos.join(' ')]))
    expect(porRota['cli-claude']).toBe('-p --output-format text --tools ')
    expect(porRota['cli-gemini']).toContain('--approval-mode plan')
    expect(porRota['cli-qwen']).toContain('--approval-mode plan')
    expect(porRota['cli-codex']).toContain('--sandbox read-only')
  })
})

describe('executar uma ferramenta de verdade', () => {
  const base = async (corpo: string, extra: Partial<Execucao> = {}): Promise<string> => {
    const dir = await ferramentaFalsa('claude', corpo)
    return executar({ caminho: join(dir, 'claude'), comando: 'claude', argumentos: ['-p'], entrada: 'pergunta', pasta: dir, ambiente: { PATH: process.env.PATH ?? '' }, tempoMs: 10_000, maxBytes: 1024, ...extra })
  }

  it('manda a pergunta pela entrada padrão e devolve a saída', async () => {
    await expect(base("let t='';process.stdin.on('data',d=>t+=d).on('end',()=>process.stdout.write('eco: '+t+' '+process.argv.slice(2).join(',')))")).resolves.toBe('eco: pergunta -p')
  })

  it('código diferente de zero diz o código e o que ela disse', async () => {
    await expect(base("process.stderr.write('não logado');process.exit(3)")).rejects.toThrow(/código 3.*não logado/u)
  })

  it('sem erro no stderr, mostra o fim da saída', async () => {
    await expect(base("process.stdout.write('só aqui');process.exit(2)")).rejects.toThrow(/código 2.*só aqui/u)
  })

  it('resposta vazia aponta o login', async () => {
    await expect(base('')).rejects.toThrow(/terminou sem escrever resposta/u)
  })

  it('tempo esgotado interrompe', async () => {
    await expect(base('setTimeout(()=>{},60000)', { tempoMs: 200 })).rejects.toThrow(/não respondeu em 0 segundos/u)
  })

  it('saída acima do teto interrompe', async () => {
    await expect(base("process.stdout.write('x'.repeat(5000));setTimeout(()=>{},60000)", { maxBytes: 100 })).rejects.toThrow(/grande demais/u)
  })

  it('cancelamento interrompe, e um sinal já cancelado nem abre', async () => {
    const controle = new AbortController()
    const pendente = base('setTimeout(()=>{},60000)', { signal: controle.signal })
    setTimeout(() => controle.abort(), 100)
    await expect(pendente).rejects.toThrow('O pedido foi cancelado.')
    await expect(base('', { signal: AbortSignal.abort() })).rejects.toThrow('O pedido foi cancelado.')
  })

  it('executável que não existe diz que não abriu', async () => {
    const dir = await pasta()
    await expect(executar({ caminho: join(dir, 'nada'), comando: 'nada', argumentos: [], entrada: '', pasta: dir, ambiente: {}, tempoMs: 5000, maxBytes: 10 })).rejects.toThrow(/Não foi possível abrir a ferramenta nada/u)
  })

  it('um spawn que lança diz que não abriu', async () => {
    const dir = await pasta()
    await expect(executar({ caminho: 'x', comando: 'x', argumentos: [], entrada: '', pasta: dir, ambiente: {}, tempoMs: 5000, maxBytes: 10, spawn: () => { throw new Error('EACCES') } })).rejects.toThrow(/x: EACCES/u)
  })
})

describe('o adaptador', () => {
  const pedido = (provider: string, model = MODELO_PADRAO): GenerateOptions => ({ provider, model, messages: [usuario('gere')] })
  const coletar = async (fluxo: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> => { const saida: StreamChunk[] = []; for await (const pedaco of fluxo) saida.push(pedaco); return saida }

  it('uma chamada vira uma execução numa pasta vazia, apagada no fim, sem segredos', async () => {
    const vistas: Execucao[] = []
    let conteudo: string[] = ['?']
    const adaptador = new AdaptadorDeLinha([{ ...FERRAMENTAS_CONHECIDAS[1]!, caminho: '/bin/gemini' }], { tempoMs: 1, maxBytes: 2 }, { HOME: '/h', OPENAI_API_KEY: 's' }, async execucao => {
      vistas.push(execucao); conteudo = await readdir(execucao.pasta); return 'resposta'
    })
    expect(await coletar(adaptador.stream(pedido('cli-gemini', 'gemini-2.5-pro')))).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'resposta' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'resposta' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    expect(conteudo).toEqual([])
    expect(vistas[0]).toMatchObject({ caminho: '/bin/gemini', comando: 'gemini', entrada: 'gere', ambiente: { HOME: '/h' }, tempoMs: 1, maxBytes: 2 })
    expect(vistas[0]!.argumentos.slice(-2)).toEqual(['--model', 'gemini-2.5-pro'])
    await expect(readdir(vistas[0]!.pasta)).rejects.toThrow()
  })

  it('a pasta é apagada também quando a ferramenta falha, e o sinal chega', async () => {
    let pastaVista = ''
    let sinal: AbortSignal | undefined
    const adaptador = new AdaptadorDeLinha([{ ...FERRAMENTAS_CONHECIDAS[0]!, caminho: '/c' }], { tempoMs: 1, maxBytes: 1 }, {}, async execucao => { pastaVista = execucao.pasta; sinal = execucao.signal; throw new Error('falhou') })
    const controle = new AbortController()
    await expect(coletar(adaptador.stream({ ...pedido('cli-claude'), signal: controle.signal }))).rejects.toThrow('falhou')
    expect(sinal).toBe(controle.signal)
    await expect(readdir(pastaVista)).rejects.toThrow()
  })

  it('rota desconhecida é recusada; nomes e modelo aparecem em português', async () => {
    const adaptador = new AdaptadorDeLinha([], { tempoMs: 1, maxBytes: 1 }, {})
    await expect(coletar(adaptador.stream(pedido('cli-x')))).rejects.toThrow(/cli-x/u)
    expect(adaptador.providerInfo('cli-claude').name).toMatch(/Claude Code/u)
    expect(await adaptador.listModels('cli-claude')).toEqual([{ provider: 'cli-claude', id: 'padrao', name: 'O modelo que a própria ferramenta usa' }])
  })

  it('o executor padrão é o real', async () => {
    const dir = await ferramentaFalsa('qwen', "process.stdout.write('real')")
    const adaptador = new AdaptadorDeLinha([{ ...FERRAMENTAS_CONHECIDAS[2]!, caminho: join(dir, 'qwen') }], { tempoMs: 10_000, maxBytes: 100 }, { PATH: process.env.PATH })
    const pedacos = await coletar(adaptador.stream(pedido('cli-qwen')))
    expect(pedacos[1]).toEqual({ type: 'text-delta', index: 0, text: 'real' })
  })
})

describe('a montagem', () => {
  const montar = async (path: string, config = {}) => {
    const { apply } = await import('../src/index.js')
    const registros: { rotas: string[]; adaptador: unknown }[] = []
    const avisos: string[] = []
    const ctx = { llm: { registerAdapter: (rotas: string[], adaptador: unknown) => { registros.push({ rotas, adaptador }) } }, logger: { info: (texto: string) => avisos.push(texto) } }
    const antes = process.env.PATH
    process.env.PATH = path
    try { apply(ctx as never, config) } finally { process.env.PATH = antes }
    return { registros, avisos }
  }

  it('registra as ferramentas achadas no PATH e diz quais', async () => {
    const dir = await ferramentaFalsa('gemini', '')
    const { registros, avisos } = await montar(dir)
    expect(registros.map(registro => registro.rotas)).toEqual([['cli-gemini']])
    expect(registros[0]!.adaptador).toBeInstanceOf(AdaptadorDeLinha)
    expect(avisos).toEqual(['Conexões por linha de comando encontradas: cli-gemini'])
  })

  it('sem nenhuma instalada, ou desligada, não registra nada', async () => {
    expect((await montar(await pasta())).registros).toEqual([])
    const dir = await ferramentaFalsa('gemini', '')
    expect((await montar(dir, { desligado: true })).registros).toEqual([])
  })
})
