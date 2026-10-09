import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppSpecV1 } from '../src/appspec.js'
import { generateFormLayer, writeFormLayer } from '../src/form-generator.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

const formSpec: AppSpecV1 = {
  schema_version: 1, problem: 'Cadastrar contatos e consultar a lista.', audience: 'Equipe local',
  journeys: ['Cadastrar e consultar contatos'], pages: [{ name: 'Contatos', sections: ['Cadastro', 'Lista'] }],
  entities: [{ name: 'Contato', kind: 'database', sensitive: false, fields: [
    { name: 'Nome', type: 'text', required: true }, { name: 'E-mail', type: 'email', required: false },
    { name: 'Telefone', type: 'phone', required: false }, { name: 'Data', type: 'date', required: false },
    { name: 'Quantidade', type: 'number', required: false }, { name: 'Ativo', type: 'boolean', required: true },
    { name: 'Situação', type: 'selection', required: true, options: ['Novo', 'Atendido'] },
    { name: 'Indicação', type: 'reference', required: false, reference_entity: 'Contato' },
  ] }], sensitive_data: { detected: [], confirmed_by_user: false },
  accessibility: { wcag_level: 'AA', keyboard_required: true, reduced_motion: true }, language: 'pt-BR',
  acceptance_criteria: ['A pessoa cadastra um contato e o encontra na lista.'],
}

describe('deterministic form and list layer', () => {
  it('generates protected server actions and an accessible manager over repositories', () => {
    const layer = generateFormLayer(formSpec, 'form-database')
    expect(layer.files.map(file => file.path)).toEqual([
      'src/server/actions/contato.ts', 'src/components/generated/contato-manager.tsx', 'src/components/generated/index.ts',
    ])
    const action = layer.files[0]!.content
    const manager = layer.files[1]!.content
    expect(action).toContain("'use server'")
    expect(action).toContain('new ContatoRepository(database).create')
    expect(action).toContain('requireFormSession')
    expect(action).toContain('new ContatoRepository(database).get(reference_indicacao)')
    expect(action).toContain("revalidatePath('/')")
    expect(manager).toContain('data-testid="contato-form"')
    expect(manager).toContain('data-testid="contato-list"')
    expect(manager).toContain('session === null ? <section aria-label="Área de gestão">')
    expect(manager).toContain('<label htmlFor="contato-nome">{"Nome"}</label>')
    expect(manager).toContain('name="situacao"')
    expect(manager).toContain('name="indicacao"')
    expect(manager).toContain('indicacaoOptions.map')
    expect(layer.protectedPaths).toEqual(layer.files.map(file => file.path))
  })

  it('writes fixed paths once and produces nothing for another category', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-form-layer-')); roots.push(root)
    const layer = generateFormLayer(formSpec, 'form-database')
    await writeFormLayer(root, layer)
    await expect(readFile(resolve(root, 'src/server/actions/contato.ts'), 'utf8')).resolves.toContain('createContato')
    await expect(writeFormLayer(root, layer)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(generateFormLayer(formSpec, 'catalog')).toEqual({ files: [], protectedPaths: [] })
  })

  it('adds the generated login to sensitive data and supports required links with a safe selector', () => {
    const sensitive: AppSpecV1 = { ...formSpec, sensitive_data: { detected: ['financial'], confirmed_by_user: true } }
    const protectedLayer = generateFormLayer(sensitive, 'form-database')
    expect(protectedLayer.files[0]?.content).toContain('requireFormSession')
    expect(protectedLayer.files[1]?.content).toContain('AccessPanel')
    const linked = { ...formSpec, entities: [
      ...formSpec.entities,
      { name: 'Tarefa', kind: 'database' as const, sensitive: false, fields: [
        { name: 'Descrição', type: 'text' as const, required: true },
        { name: 'Contato', type: 'reference' as const, required: true, reference_entity: 'Contato' },
      ] },
    ] }
    const linkedLayer = generateFormLayer(linked, 'form-database')
    const taskAction = linkedLayer.files.find(file => file.path === 'src/server/actions/tarefa.ts')?.content
    const taskManager = linkedLayer.files.find(file => file.path === 'src/components/generated/tarefa-manager.tsx')?.content
    expect(taskAction).toContain("if (reference_contato === '') throw new Error")
    expect(taskAction).toContain('new ContatoRepository(database).get(reference_contato)')
    expect(taskManager).toContain('contatoOptions.map')
  })
})

describe('T-30: formulário PÚBLICO tem teto de volume', () => {
  const publico: AppSpecV1 = {
    schema_version: 1, problem: 'Receber contatos do site.', audience: 'Público',
    journeys: ['Enviar contato'], pages: [{ name: 'Contato', sections: ['Formulário'] }],
    entities: [{ name: 'Contato', kind: 'database', sensitive: false, fields: [
      { name: 'Nome', type: 'text', required: true },
      { name: 'E-mail', type: 'email', required: true },
    ] }],
    sensitive_data: { detected: [], confirmed_by_user: false },
    accessibility: { wcag_level: 'AA', keyboard_required: true, reduced_motion: true },
    language: 'pt-BR', acceptance_criteria: ['Recebe contatos.'],
  }
  const comLogin: AppSpecV1 = { ...publico, sensitive_data: { detected: ['cpf'], confirmed_by_user: true } }
  const acao = (spec: AppSpecV1): string =>
    generateFormLayer(spec, 'form-database').files.find(file => file.path.includes('server/actions'))!.content

  it('sem login, o envio passa por um teto por janela ANTES de gravar', () => {
    // Um formulário de contato com nome, e-mail e telefone não dispara
    // `requiresFormSubmissionAuth`, e então a Server Action aceitava POST de
    // qualquer pessoa na internet, sem cookie, sem limite. Nenhuma cota falava
    // de VOLUME — só de tamanho por campo. O disco do dono acabava.
    const gerado = acao(publico)
    expect(gerado).toContain('function assertPublicFormOpen(database: DatabaseSync): void')
    expect(gerado).toContain('const PUBLIC_WINDOW_LIMIT = 60')
    // ANTES de gravar: conferir depois só descobriria o estouro tendo gravado.
    //
    // A chamada tem de EXISTIR, e não só vir antes. A primeira versão deste
    // teste comparava só as posições — e `indexOf` devolve -1 para o que não
    // existe, que é menor que qualquer índice. Removendo a chamada e deixando
    // só a função, o teste passava: ele afirmava que um teto nunca executado
    // estava protegendo o formulário.
    const chamada = gerado.indexOf('assertPublicFormOpen(database)')
    expect(chamada).toBeGreaterThanOrEqual(0)
    expect(chamada).toBeLessThan(gerado.indexOf('.create({'))
  })

  it('a contagem é GLOBAL e sai da própria tabela, não de uma chave que o atacante escolhe', () => {
    // Atrás de proxy, o endereço que chega é o do proxy: um teto por endereço
    // seria um teto sobre um valor que o atacante controla. E a janela é
    // contada em `created_at`, que toda tabela gerada já tem — uma tabela nova
    // de registro seria mais um lugar para divergir do que ela deveria contar.
    const gerado = acao(publico)
    expect(gerado).toContain('SELECT count(*) AS total FROM \\"entity_contato\\" WHERE \\"created_at\\" > ?')
    expect(gerado).not.toContain('x-forwarded-for')
    expect(gerado).not.toContain('headers()')
  })

  it('com login exigido, o teto NÃO aparece', () => {
    // Quem entrou já é contido pelo próprio login e pelos limites de sessão.
    // Um teto global ali deixaria um usuário legítimo travar os outros.
    const gerado = acao(comLogin)
    expect(gerado).toContain('requireFormSession')
    expect(gerado).not.toContain('assertPublicFormOpen')
    expect(gerado).not.toContain('PUBLIC_WINDOW_LIMIT')
  })

  it('a frase que a pessoa lê diz que é temporário, e não que ela errou', () => {
    expect(acao(publico)).toContain('está pausado por pouco tempo')
  })
})
