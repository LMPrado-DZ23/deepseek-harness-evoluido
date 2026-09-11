import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppSpecV1 } from '../src/appspec.js'
import { generateCrudLayer, writeCrudLayer } from '../src/crud-generator.js'

const roots:string[]=[]
afterEach(async()=>Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true}))))
const spec:AppSpecV1={schema_version:1,problem:'Gerenciar clientes e próximas tarefas.',audience:'Equipe',journeys:['Criar, editar e excluir clientes'],pages:[{name:'Clientes',sections:['Gestão']}],entities:[{name:'Cliente',kind:'database',sensitive:false,fields:[{name:'Nome',type:'text',required:true},{name:'Status',type:'selection',required:true,options:['Novo','Atendido']},{name:'Ativo',type:'boolean',required:true},{name:'Limite',type:'number',required:false},{name:'Data',type:'date',required:false},{name:'E-mail',type:'email',required:false},{name:'Telefone',type:'phone',required:false}]}],sensitive_data:{detected:[],confirmed_by_user:false},accessibility:{wcag_level:'AA',keyboard_required:true,reduced_motion:true},language:'pt-BR',acceptance_criteria:['A equipe gerencia clientes.']}
describe('generated CRUD panel',()=>{
  it('generates authenticated create, edit and confirmed delete controls',()=>{const layer=generateCrudLayer(spec,'crud-panel');expect(layer.files.map(file=>file.path)).toEqual(['src/components/generated/confirm-delete-button.tsx','src/server/actions/cliente.ts','src/components/generated/cliente-panel.tsx','src/components/generated/index.ts']);const joined=layer.files.map(file=>file.content).join('\n');expect(joined).toContain('requireFormSession');expect(joined).toContain('Salvar alterações');expect(joined).toContain('window.confirm("Tem certeza de que deseja excluir este item?")');expect(joined).toContain('data-testid="cliente-create-form"');expect(generateCrudLayer(spec,'catalog')).toEqual({files:[],protectedPaths:[]})})
  it('writes protected paths once',async()=>{const root=await mkdtemp(join(tmpdir(),'dz23-crud-'));roots.push(root);const layer=generateCrudLayer(spec,'crud-panel');await writeCrudLayer(root,layer);await expect(readFile(resolve(root,'src/server/actions/cliente.ts'),'utf8')).resolves.toContain('deleteCliente');await expect(writeCrudLayer(root,layer)).rejects.toMatchObject({code:'EEXIST'})})
  it('generates a safe relation selector, validates on the server and translates restricted deletion',()=>{const linked:AppSpecV1={...spec,entities:[{name:'Cliente',kind:'database',sensitive:false,fields:[{name:'Nome',type:'text',required:true},{name:'Dono',type:'reference',required:false,reference_entity:'Cliente'}]}]};const layer=generateCrudLayer(linked,'crud-panel');const joined=layer.files.map(file=>file.content).join('\n');expect(joined).toContain('donoOptions.map');expect(joined).toContain('new ClienteRepository(database).get(reference_dono)');expect(joined).toContain('FOREIGN KEY constraint failed');expect(joined).toContain('Não é possível excluir este item porque ele é usado por outro cadastro.')})
})

describe('ACHADO: apagar em painel compartilhado é do DONO',()=>{
  it('a ação de apagar exige papel de dono; criar e editar continuam abertos a quem foi convidado',()=>{
    // O painel CRUD é COMPARTILHADO por desenho — é a categoria de painel de
    // administração, e por isso todo mundo vê e edita os mesmos registros. O
    // que não podia continuar compartilhado era APAGAR: `requireFormSession`
    // sem segundo argumento vale `['owner','member']`, a tabela genérica não
    // tem coluna de dono, não há apagar-suave nem trilha, e o `id` vem de um
    // campo oculto do formulário. Um único convidado esvaziava a base.
    const layer = generateCrudLayer(spec, 'crud-panel')
    const acoes = layer.files.find(file => file.path === 'src/server/actions/cliente.ts')!.content
    expect(acoes).toContain("export async function deleteCliente(formData:FormData):Promise<void>{await requireFormSession(formData,['owner'])")
    // Criar e editar NÃO foram restringidos: o painel existe para ser
    // compartilhado, e exigir o dono para editar transformaria a categoria em
    // outra coisa.
    expect(acoes).toContain('export async function createCliente(formData:FormData):Promise<void>{await requireFormSession(formData);')
    expect(acoes).toContain('export async function updateCliente(formData:FormData):Promise<void>{await requireFormSession(formData);')
  })

  it('a tela não oferece o botão que o servidor vai recusar',()=>{
    // Botão que existe e falha ensina a pessoa que o aplicativo é quebrado. A
    // autorização continua no SERVIDOR — esconder é cortesia, não defesa.
    const painel = generateCrudLayer(spec, 'crud-panel')
      .files.find(file => file.path === 'src/components/generated/cliente-panel.tsx')!.content
    expect(painel).toContain("{session.role==='owner'?<form action={deleteCliente}>")
    expect(painel).toContain('<ConfirmDeleteButton/></form>:null}')
  })

  it('ACHADO: opção com aspas não quebra o atributo JSX do <option>',()=>{
    // `JSON.stringify` escapa `"` como `\"`, e atributo JSX NÃO processa
    // contrabarra: a string terminava na primeira aspa e o aplicativo gerado
    // não compilava. O escape certo é o mesmo do filho — `{"..."}` —, que o
    // arquivo já usava a dois caracteres de distância, no mesmo `<option>`.
    const comAspas: AppSpecV1 = { ...spec, entities: [{
      name: 'Cliente', kind: 'database', sensitive: false,
      fields: [{ name: 'Status', type: 'selection', required: true, options: ['ok" onError={x} ', 'normal'] }],
    }] }
    const painel = generateCrudLayer(comAspas, 'crud-panel')
      .files.find(file => file.path.endsWith('cliente-panel.tsx'))!.content
    expect(painel).toContain('<option value={"ok\\" onError={x} "}>')
    expect(painel).not.toContain('<option value="ok\\"')
    // E a prova que importa: o arquivo gerado COMPILA. Antes, a mesma opção
    // produzia erro de sintaxe — o aplicativo simplesmente não nascia.
    const transpilado = transpileModule(painel, {
      compilerOptions: { jsx: JsxEmit.Preserve, module: ModuleKind.NodeNext, target: ScriptTarget.ES2023 },
      reportDiagnostics: true,
      fileName: 'cliente-panel.tsx',
    })
    expect(transpilado.diagnostics ?? []).toEqual([])
  })
})
