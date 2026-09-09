import { useEffect, useRef, useState } from 'react'

/**
 * Um botão que MOSTRA que está trabalhando.
 *
 * Nenhum botão do caminho Ideia → Perguntas → Plano → Criação avisava nada:
 * a pessoa apertava "Aprovar este plano", ficava 1 a 3 segundos sem resposta
 * nenhuma e apertava de novo. Em leitor de tela, silêncio completo.
 *
 * Enquanto a chamada corre, ele fica desabilitado (o clique duplo deixa de
 * existir), diz o que está fazendo no gerúndio e anuncia `aria-busy` para quem
 * ouve a tela em vez de olhar.
 *
 * DUAS COISAS que `aria-busy` sozinho não resolve, e que um auditor mediu no
 * navegador:
 *
 * 1. `aria-busy` num botão não é ANUNCIADO. Ele descreve o estado para quem
 *    for consultar, e ninguém consulta. Por isso existe aqui uma região viva
 *    invisível: ela recebe o gerúndio quando a chamada começa, e é ela que o
 *    leitor de tela lê em voz alta.
 * 2. Desabilitar o elemento que está com o FOCO joga o foco no `<body>`. Quem
 *    navega por teclado apertava Enter e perdia o lugar — e, ao voltar, o Tab
 *    recomeçava do topo da página. Se o foco caiu no corpo por causa DESTE
 *    botão, ele volta para cá quando a chamada termina.
 */
export function PendingButton({ label, busyLabel, action, className = 'primary', disabled = false, testId, ariaLabel }: {
  label: string; busyLabel: string; action: () => Promise<void>
  className?: string; disabled?: boolean; testId?: string; ariaLabel?: string
}) {
  const [pending, setPending] = useState(false)
  const mounted = useRef(true)
  const button = useRef<HTMLButtonElement>(null)
  const hadFocus = useRef(false)
  useEffect(() => () => { mounted.current = false }, [])
  // Depois que a chamada termina, o botão volta a aceitar foco. Devolvê-lo só
  // quando o foco está no `<body>` evita roubar o foco de quem já se moveu para
  // outro lugar enquanto esperava.
  useEffect(() => {
    if (pending || !hadFocus.current) return
    hadFocus.current = false
    if (document.activeElement === document.body) button.current?.focus()
  }, [pending])
  return <>
    <button
      ref={button} type="button"
      className={className} disabled={disabled || pending} aria-busy={pending}
      {...(testId === undefined ? {} : { 'data-testid': testId })}
      {...(ariaLabel === undefined ? {} : { 'aria-label': ariaLabel })}
      onClick={() => {
        if (pending) return
        hadFocus.current = document.activeElement === button.current
        setPending(true)
        void action().finally(() => { if (mounted.current) setPending(false) })
      }}
    >{pending ? busyLabel : label}</button>
    <span className="sr-only" role="status">{pending ? busyLabel : ''}</span>
  </>
}
