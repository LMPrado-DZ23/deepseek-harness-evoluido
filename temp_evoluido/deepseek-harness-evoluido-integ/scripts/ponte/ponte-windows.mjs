#!/usr/bin/env node
/**
 * PONTE DE SAÍDA — lado do Windows (ver ponte-wsl.mjs).
 *
 * Liga-se ao WSL por localhost (o repasse que o WSL já oferece), recebe pedidos
 * "ABRIR id host porta" no canal de controle e, para cada um, abre a conexão
 * para fora e um canal de dados de volta ao WSL. Não escuta porta nenhuma: não
 * muda firewall nem expõe nada. A lista de hosts é conferida de novo AQUI.
 */
import { connect } from 'node:net'
import { HOSTS_PERMITIDOS, PORTA_AGENTE, destinoPermitido } from './ponte-wsl.mjs'

const TOKEN = process.env.FRIGG_PONTE_TOKEN
if (TOKEN === undefined || TOKEN.length < 32) { console.error('FRIGG_PONTE_TOKEN ausente'); process.exit(2) }

function ligar() {
  const controle = connect(PORTA_AGENTE, '127.0.0.1', () => { controle.write(`CONTROLE ${TOKEN}\n`); console.log('ligado ao WSL') })
  let sobra = ''
  controle.on('data', pedaco => {
    sobra += pedaco.toString('utf8')
    let fim
    while ((fim = sobra.indexOf('\n')) >= 0) {
      const linha = sobra.slice(0, fim); sobra = sobra.slice(fim + 1)
      const [cmd, id, host, porta] = linha.split(' ')
      if (cmd !== 'ABRIR' || destinoPermitido(`${host}:${porta}`, HOSTS_PERMITIDOS) === undefined) continue
      const fora = connect(Number(porta), host, () => {
        const volta = connect(PORTA_AGENTE, '127.0.0.1', () => { volta.write(`DADOS ${TOKEN} ${id}\n`); fora.pipe(volta); volta.pipe(fora) })
        volta.on('error', () => fora.destroy()); fora.on('close', () => volta.destroy()); volta.on('close', () => fora.destroy())
      })
      fora.on('error', () => {})
    }
  })
  controle.on('error', () => {})
  controle.on('close', () => setTimeout(ligar, 2000))
}
ligar()
