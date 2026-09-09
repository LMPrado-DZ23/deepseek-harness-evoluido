import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { HubPanel } from './hub/HubPanel'
import { isHubPath } from './hub/presentation'
import { AssistantEntry, ASSISTANT_PATH } from './assistant/AssistantEntry'
import { TeamScreen } from './team/TeamPanel'
import { HelpScreen, isHelpPath } from './help/HelpScreen'
import { ProjectsScreen, isProjectsPath } from './projects/ProjectsScreen'
import { isTeamPath } from './team/teamApi'
import './styles.css'
import { registerStudioPwa } from './pwa/register'
import { SessionRevocationBoundary } from './session/SessionRevocationBoundary'
import { StudioShell } from './StudioShell'

const Screen = window.location.pathname === ASSISTANT_PATH
  ? AssistantEntry
  : isHubPath(window.location.pathname) ? HubPanel
    : isTeamPath(window.location.pathname) ? TeamScreen
      : isHelpPath(window.location.pathname) ? HelpScreen
        : isProjectsPath(window.location.pathname) ? ProjectsScreen : App
/**
 * A tela inicial já traz a própria casca (ela precisa do estado de saúde, da
 * conta e do aviso de notificação no topo). As demais recebem a casca AQUI —
 * antes elas não recebiam casca nenhuma, e quem entrava em Ajuda, Integrações,
 * Trabalho em equipe ou no assistente ficava sem navegação.
 */
const rendered = Screen === App
  ? <Screen />
  : <StudioShell><Screen /></StudioShell>

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><SessionRevocationBoundary>{rendered}</SessionRevocationBoundary></React.StrictMode>,
)
registerStudioPwa()
