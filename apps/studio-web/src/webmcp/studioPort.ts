/**
 * A porta das ferramentas WebMCP: as MESMAS chamadas que a tela faz.
 *
 * Existe como arquivo próprio para ficar impossível uma ferramenta construir um
 * caminho paralelo: tudo o que o agente do navegador consegue disparar passa
 * por `api`, com o mesmo cookie de sessão e o mesmo CSRF que a pessoa usa. Se o
 * servidor recusaria a ela, recusa a ele.
 */
import { api } from '../api'
import type { StudioPort } from './tools'

export const studioPort: StudioPort = {
  listProjects: () => api<{ projects: { project_id: string; name: string; state: string }[] }>('/projects').then(body => body.projects),
  projectDetails: projectId => api(`/projects/${encodeURIComponent(projectId)}`),
  createProject: input => api<{ project: { project_id: string } }>('/projects', {
    method: 'POST',
    // `category` e `privacy` NÃO vêm do agente: são as escolhas mais
    // conservadoras, e a pessoa muda na tela. Deixar o agente escolher a
    // privacidade seria deixá-lo decidir para onde o texto dela vai.
    body: JSON.stringify({ name: input.name, original_brief: input.brief, category: 'landing-page', privacy: 'local-only' }),
  }).then(body => ({ project_id: body.project.project_id })),
}
