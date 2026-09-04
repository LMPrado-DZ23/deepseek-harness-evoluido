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
  it('writes fixed paths once',async()=>{const root=await mkdtemp(join(tmpdir(),'dz23-auth-layer-'));roots.push(root);const layer=generateAuthLayer(spec,'crud-panel');await writeAuthLayer(root,layer);await expect(readFile(resolve(root,'src/auth/service.ts'),'utf8')).resolves.toContain('GeneratedAuthService');await expect(writeAuthLayer(root,layer)).rejects.toMatchObject({code:'EEXIST'})})
})
