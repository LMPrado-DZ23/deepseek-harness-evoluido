import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppSpecV1 } from '../src/appspec.js'
import { generateAuthLayer, requiresGeneratedAuth, writeAuthLayer } from '../src/auth-generator.js'

const roots:string[]=[]
afterEach(async()=>Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true}))))
const spec:AppSpecV1={schema_version:1,problem:'Organizar contatos da empresa.',audience:'Equipe',journeys:['Gerenciar contatos'],pages:[{name:'Contatos',sections:['Painel']}],entities:[{name:'Contato',kind:'database',sensitive:false,fields:[{name:'Nome',type:'text',required:true}]}],sensitive_data:{detected:[],confirmed_by_user:false},accessibility:{wcag_level:'AA',keyboard_required:true,reduced_motion:true},language:'pt-BR',acceptance_criteria:['A equipe gerencia contatos.']}

describe('generated passwordless access layer',()=>{
  it('is required for every data form while only sensitive submissions require a session',()=>{
    expect(requiresGeneratedAuth(spec,'crud-panel')).toBe(true)
    expect(requiresGeneratedAuth(spec,'form-database')).toBe(true)
    expect(requiresGeneratedAuth({...spec,sensitive_data:{detected:['financial'],confirmed_by_user:true}},'form-database')).toBe(true)
    expect(requiresGeneratedAuth({...spec,entities:[{...spec.entities[0]!,kind:'database',sensitive:true}] as AppSpecV1['entities']},'form-database')).toBe(true)
  })
  it('generates protected migrations, delivery, service, runtime, route and tests',()=>{
    const layer=generateAuthLayer(spec,'crud-panel')
    expect(layer.required).toBe(true)
    expect(layer.files.map(file=>file.path)).toEqual(['src/auth/migrations.ts','src/auth/email.ts','src/auth/service.ts','src/auth/runtime.ts','src/auth/actions.ts','src/components/generated/access-panel.tsx','app/api/auth/session/route.ts','tests/generated-auth.spec.ts'])
    const source=Object.fromEntries(layer.files.map(file=>[file.path,file.content]))
    expect(source['src/auth/service.ts']).toContain('attempts >= 5')
    expect(source['src/auth/service.ts']).toContain('request_id = ?')
    expect(source['src/auth/service.ts']).toContain('recent >= 3 || tooSoon')
    expect(source['src/auth/migrations.ts']).toContain('auth_schema_migrations')
    expect(source['src/auth/migrations.ts']).not.toContain('PRAGMA user_version = 2')
    expect(source['src/auth/runtime.ts']).toContain("httpOnly:true")
    expect(source['src/auth/runtime.ts']).toContain("secure:true")
    expect(source['src/auth/runtime.ts']).toContain("service.validateCsrf(session")
    expect(source['src/components/generated/access-panel.tsx']).toContain('<form action={logoutAction}><input type="hidden" name="_csrf" value={csrf}/>')
    expect(source['src/auth/email.ts']).toContain('STUDIO_CAPTURE_FORBIDDEN_OUTSIDE_VERIFICATION')
    expect(source['src/auth/runtime.ts']).toContain("CODE_REQUEST_COOKIE = 'dz23_app_code_request'")
    expect(source['src/auth/runtime.ts']).toContain('jar.set(CODE_REQUEST_COOKIE,result.requestId')
    expect(source['src/auth/runtime.ts']).not.toContain("if(result.status==='sent')")
    expect(source['app/api/auth/session/route.ts']).toContain('status:401')
    expect(generateAuthLayer(spec,'catalog')).toEqual({required:false,files:[],protectedPaths:[]})
  })
  it('OS-90: banco travado no aplicativo gerado NAO vira "faca login de novo" para sempre',()=>{
    // O `catch` de `currentSession` engolia TUDO. Banco travado, disco cheio ou
    // migracao ausente viravam 'nao esta logado', e a pessoa ficava presa num
    // laco de login que nunca ia funcionar — sem nada na tela dizendo que o
    // problema era do servidor. So FALHA DE AUTENTICACAO pode virar `null`.
    const runtime=Object.fromEntries(generateAuthLayer(spec,'crud-panel').files.map(file=>[file.path,file.content]))['src/auth/runtime.ts']!
    const linha=runtime.split('\n').find(value=>value.includes('export async function currentSession'))!
    expect(linha).toContain('error instanceof AppAuthError')
    expect(linha).toContain('throw error')
    expect(linha).not.toContain('catch { return null }')
  })

  it('writes fixed paths once',async()=>{const root=await mkdtemp(join(tmpdir(),'dz23-auth-layer-'));roots.push(root);const layer=generateAuthLayer(spec,'crud-panel');await writeAuthLayer(root,layer);await expect(readFile(resolve(root,'src/auth/service.ts'),'utf8')).resolves.toContain('GeneratedAuthService');await expect(writeAuthLayer(root,layer)).rejects.toMatchObject({code:'EEXIST'})})
})

describe('o aplicativo gerado nao apaga o historico de envios quando o arquivo esta corrompido',()=>{
  const emailSource=()=>{
    const layer=generateAuthLayer(spec,'crud-panel')
    const file=layer.files.find(item=>item.path==='src/auth/email.ts')
    expect(file,'a camada gerada deixou de trazer src/auth/email.ts').toBeDefined()
    return file!.content
  }

  it('distingue arquivo ausente de arquivo quebrado',()=>{
    const source=emailSource()
    // Ausente e o caso normal da primeira escrita: lista vazia.
    expect(source).toContain("=== 'ENOENT'")
    // Qualquer outra falha SOBE, em vez de virar lista vazia e mandar a linha
    // seguinte sobrescrever o arquivo.
    expect(source).toContain('throw error')
    expect(source).toContain('STUDIO_CAPTURE_CORRUPTED')
  })

  it('nao restou nenhum bloco de captura vazio no codigo gerado',()=>{
    // Era o unico `catch` sem tratamento do repositorio, e ele viajava para
    // dentro de TODO aplicativo gerado com formulario.
    expect(emailSource()).not.toContain('catch {}')
  })

  it('a captura do Studio escreve de forma ATOMICA, como a da previa',()=>{
    // Achado G da revisao adversarial: o remetente do Studio escrevia direto no
    // arquivo final, entao era o UNICO capaz de PRODUZIR o JSON truncado que
    // readCapture agora recusa. Uma queda no meio da escrita travaria o envio
    // para sempre - o conserto de leitura teria criado um beco onde antes havia
    // auto-cura por sobrescrita.
    const source=emailSource()
    // Dois `rename`: um por remetente. Antes havia so um.
    expect(source.split('await rename(temporary, this.path)')).toHaveLength(3)
    // E nenhuma escrita direta no caminho final.
    expect(source).not.toContain('await writeFile(this.path,')
  })

  it('os dois remetentes usam a mesma leitura conferida',()=>{
    const source=emailSource()
    // Captura do Studio e captura da previa: duas classes, um so caminho de
    // leitura. Duas copias divergiriam no primeiro conserto.
    expect(source.split('await readCapture(this.path)')).toHaveLength(3)
  })
})
