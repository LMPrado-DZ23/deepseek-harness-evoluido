import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { HubPanel } from './hub/HubPanel'
import { isHubPath } from './hub/presentation'
import { AssistantEntry, ASSISTANT_PATH } from './assistant/AssistantEntry'
import { TeamScreen } from './team/TeamPanel'
import { HelpScreen, isHelpPath } from './help/HelpScreen'
import { MissionScreen } from './mission/MissionScreen'
import { isMissionPath } from './mission/missionApi'
import { ProjectsScreen, isProjectsPath } from './projects/ProjectsScreen'
import { isTeamPath } from './team/teamApi'
import { AgendadoScreen, BibliotecaScreen, HabilidadesScreen, PluginsScreen } from './destinos/Destinos'
import { destinoDoCaminho } from './destinos/destinos'
import { EmpresaScreen } from './empresa/Empresa'
import { isEmpresaPath } from './empresa/empresaApi'
/*
  O TEMA VEM ANTES da folha antiga, de propósito: `styles.css` ainda tem tokens
  claros no `:root`, e quem vier depois vence. Enquanto a migração acontece, é a
  folha antiga que sobrescreve o que ainda não migrou — e não o contrário.
*/
import './theme.css'
import './shell/shell.css'
import './home/home.css'
import './tarefa/tarefa.css'
import './preferencias/preferencias.css'
import './empresa/empresa.css'
import './styles.css'
import { registerStudioPwa } from './pwa/register'
import { SessionRevocationBoundary } from './session/SessionRevocationBoundary'
import { IdiomaProvider } from './i18n/IdiomaProvider'
import { WorkspaceShell } from './shell/WorkspaceShell'

/*
  Os quatro destinos novos vêm ANTES do Hub na escolha, e a ordem é de
  propósito: `/studio/habilidades` e `/studio/plugins` são endereços próprios, e
  o endereço antigo do Hub continua existindo com a tela inteira, para quem o
  tiver guardado.
*/
const destino = destinoDoCaminho(window.location.pathname)
const Screen = destino === 'habilidades' ? HabilidadesScreen
  : destino === 'plugins' ? PluginsScreen
    : destino === 'biblioteca' ? BibliotecaScreen
      : destino === 'agendado' ? AgendadoScreen
        : isEmpresaPath(window.location.pathname) ? EmpresaScreen
          : window.location.pathname === ASSISTANT_PATH ? AssistantEntry
            : isHubPath(window.location.pathname) ? HubPanel
              : isTeamPath(window.location.pathname) ? TeamScreen
                : isHelpPath(window.location.pathname) ? HelpScreen
                  : isProjectsPath(window.location.pathname) ? ProjectsScreen
                    : isMissionPath(window.location.pathname) ? MissionScreen : App
/**
 * A tela inicial já traz a própria casca (ela precisa do estado de saúde, da
 * conta e do aviso de notificação no topo). As demais recebem a casca AQUI —
 * antes elas não recebiam casca nenhuma, e quem entrava em Ajuda, Integrações,
 * Trabalho em equipe ou no assistente ficava sem navegação.
 */
const rendered = Screen === App
  ? <Screen />
  : <WorkspaceShell><Screen /></WorkspaceShell>

/*
  O tema grafite é o PADRÃO deste produto. A classe entra no `<html>` aqui, e
  não no HTML estático, porque é daqui que ela sai quando alguém escolher o
  claro — e ter os dois lugares seria a segunda verdade de sempre.
*/
document.documentElement.classList.add('dz23')
ReactDOM.createRoot(document.getElementById('root')!).render(
  /*
    O IDIOMA envolve TUDO, e por fora da fronteira de sessão.

    Por fora de propósito: a tela que aparece quando a sessão é revogada também
    tem de sair no idioma da pessoa, e o adendo pede seleção "na tela de
    entrada, antes do login". Um provedor por dentro deixaria justamente as
    telas de fora da sessão em português.
  */
  <React.StrictMode><IdiomaProvider><SessionRevocationBoundary>{rendered}</SessionRevocationBoundary></IdiomaProvider></React.StrictMode>,
)
registerStudioPwa()
