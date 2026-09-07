const emailForm = document.querySelector('#email-form')
const codeForm = document.querySelector('#code-form')
const emailInput = document.querySelector('#email')
const codeInput = document.querySelector('#code')
const status = document.querySelector('#status')
const back = document.querySelector('#back')
const sessionGenerationKey = 'dz23.studio.session-generation.v1'

function message(text, kind = '') {
  status.textContent = text
  status.dataset.kind = kind
}

async function post(path, body) {
  const response = await fetch(`/api/studio/identity${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error ?? 'Não foi possível concluir. Tente novamente.')
  return payload
}

emailForm.addEventListener('submit', async event => {
  event.preventDefault()
  message('Enviando o código…')
  try {
    await post('/magic/start', { email: emailInput.value })
    emailForm.hidden = true
    codeForm.hidden = false
    codeInput.focus()
    message('Confira seu e-mail e digite o código recebido.', 'success')
  } catch (error) {
    message(error instanceof Error ? error.message : 'Não foi possível enviar o código.', 'error')
  }
})

codeForm.addEventListener('submit', async event => {
  event.preventDefault()
  message('Verificando…')
  try {
    const issued = await post('/magic/verify', {
      email: emailInput.value,
      code: codeInput.value,
      device_label: navigator.userAgentData?.platform ?? navigator.platform ?? 'Navegador',
    })
    if (typeof issued.csrf_token !== 'string' || issued.csrf_token.length < 32) throw new Error('A sessão não pôde ser protegida.')
    if (typeof issued.session_generation !== 'string' || !/^[a-f0-9]{32}$/.test(issued.session_generation)) throw new Error('A sessão não pôde ser protegida.')
    window.sessionStorage.setItem('dz23.studio.csrf.v1', issued.csrf_token)
    window.localStorage.setItem(sessionGenerationKey, issued.session_generation)
    message('Tudo certo. Abrindo seu espaço…', 'success')
    window.location.assign('/api/studio/identity/harness/session')
  } catch (error) {
    message(error instanceof Error ? error.message : 'Código inválido ou expirado.', 'error')
  }
})

back.addEventListener('click', () => {
  codeForm.hidden = true
  emailForm.hidden = false
  codeInput.value = ''
  message('')
  emailInput.focus()
})
