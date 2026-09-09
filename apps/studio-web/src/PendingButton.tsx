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
 */
export function PendingButton({ label, busyLabel, action, className = 'primary', disabled = false, testId, ariaLabel }: {
  label: string; busyLabel: string; action: () => Promise<void>
  className?: string; disabled?: boolean; testId?: string; ariaLabel?: string
}) {
  const [pending, setPending] = useState(false)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])
  return <button
    className={className} disabled={disabled || pending} aria-busy={pending}
    {...(testId === undefined ? {} : { 'data-testid': testId })}
    {...(ariaLabel === undefined ? {} : { 'aria-label': ariaLabel })}
    onClick={() => {
      if (pending) return
      setPending(true)
      void action().finally(() => { if (mounted.current) setPending(false) })
    }}
  >{pending ? busyLabel : label}</button>
}
