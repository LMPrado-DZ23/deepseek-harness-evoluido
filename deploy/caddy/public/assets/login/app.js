const emailForm = document.querySelector('#email-form')
const codeForm = document.querySelector('#code-form')
const emailInput = document.querySelector('#email')
const codeInput = document.querySelector('#code')
const status = document.querySelector('#status')
const back = document.querySelector('#back')

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
    await post('/magic/verify', {
      email: emailInput.value,
      code: codeInput.value,
      device_label: navigator.userAgentData?.platform ?? navigator.platform ?? 'Navegador',
    })
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
