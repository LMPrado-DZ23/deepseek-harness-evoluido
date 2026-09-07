import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { HubPanel } from './hub/HubPanel'
import { isHubPath } from './hub/presentation'
import { AssistantEntry, ASSISTANT_PATH } from './assistant/AssistantEntry'
import './styles.css'
import { registerStudioPwa } from './pwa/register'
import { SessionRevocationBoundary } from './session/SessionRevocationBoundary'

const Screen = window.location.pathname === ASSISTANT_PATH
  ? AssistantEntry
  : isHubPath(window.location.pathname) ? HubPanel : App
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><SessionRevocationBoundary><Screen /></SessionRevocationBoundary></React.StrictMode>,
)
registerStudioPwa()
