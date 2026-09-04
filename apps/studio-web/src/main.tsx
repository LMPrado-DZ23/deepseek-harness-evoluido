import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { HubPanel } from './hub/HubPanel'
import { isHubPath } from './hub/presentation'
import './styles.css'
import { registerStudioPwa } from './pwa/register'
// `/studio/hub` opens the Integration Hub; every other path stays with the main application.
const Screen = isHubPath(window.location.pathname) ? HubPanel : App
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><Screen /></React.StrictMode>)
registerStudioPwa()
