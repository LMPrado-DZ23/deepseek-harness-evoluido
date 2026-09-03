import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, resolve } from 'node:path'

const dist = resolve(process.cwd(), 'dist')
let step = 0
const questions = [
  { id: 'audience', text: 'Para quem você quer criar este projeto?' },
  { id: 'goal', text: 'O que a pessoa deve conseguir fazer ou entender?' },
  { id: 'content', text: 'Quais informações ou itens precisam aparecer?' },
]
const plan = { slices: [{ slice_id: 'one', title: 'Página principal', description: 'Apresentar serviços e contato.', acceptance_criteria: ['A página abre e pode ser usada pelo teclado.'] }] }

createServer(async (request, response) => {
  if (request.url === '/healthz') return send(response, 200, 'ok', 'text/plain')
  if (!request.headers.cookie?.includes('dz23_studio_session=e2e')) return send(response, 401, request.url?.startsWith('/api/') ? '{"error":"Entre para continuar."}' : 'Entre para continuar.', request.url?.startsWith('/api/') ? 'application/json' : 'text/plain')
  const url = new URL(request.url ?? '/', 'http://local')
  if (url.pathname.startsWith('/api/studio/apps')) {
    if (request.method !== 'GET' && request.headers['x-dz23-csrf'] !== 'csrf-e2e') return send(response, 401, '{"error":"CSRF"}', 'application/json')
    if (url.pathname.endsWith('/health')) return json(response, { state: 'OK', route: 'ollama-local', builder: 'OK', disk: 'OK' })
    if (request.method === 'POST' && url.pathname.endsWith('/projects')) { step = 0; return json(response, { project: { project_id: 'e2e-project', state: 'DRAFT' }, next: questions[0] }, 201) }
    if (request.method === 'POST' && url.pathname.endsWith('/intake/answer')) { step++; return json(response, step < questions.length ? { next: questions[step] } : { spec: { schema_version: 1 }, next: null }, step < questions.length ? 200 : 201) }
    if (request.method === 'POST' && url.pathname.endsWith('/plan/change')) return json(response, { plan: { ...plan, status: 'CHANGE_REQUESTED' } })
    if (request.method === 'POST' && url.pathname.endsWith('/plan/approve')) return json(response, { plan: { ...plan, status: 'APPROVED' } })
    if (request.method === 'POST' && url.pathname.endsWith('/plan')) return json(response, { plan }, 201)
    if (request.method === 'POST' && url.pathname.endsWith('/generate')) return json(response, { state: 'VERIFIED_PROTOTYPE', attempts: 1, message: 'Protótipo verificado localmente.' })
    return json(response, { error: 'Rota ausente.' }, 404)
  }
  const requested = url.pathname === '/studio' || url.pathname === '/studio/' ? 'index.html' : url.pathname.replace(/^\/studio\//u, '')
  const path = resolve(dist, requested)
  if (!path.startsWith(`${dist}/`) && path !== resolve(dist, 'index.html')) return send(response, 400, 'Caminho inválido.', 'text/plain')
  const selected = await stat(path).then(info => info.isFile() ? path : resolve(dist, 'index.html')).catch(() => extname(requested) === '' ? resolve(dist, 'index.html') : undefined)
  if (selected === undefined) return send(response, 404, 'Ausente.', 'text/plain')
  response.writeHead(200, { 'content-type': contentType(selected), 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'" })
  createReadStream(selected).pipe(response)
}).listen(4179, '127.0.0.1')

function json(response, body, status = 200) { send(response, status, JSON.stringify(body), 'application/json') }
function send(response, status, body, type) { response.writeHead(status, { 'content-type': `${type}; charset=utf-8` }); response.end(body) }
function contentType(path) { return ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg' })[extname(path)] ?? 'application/octet-stream' }
