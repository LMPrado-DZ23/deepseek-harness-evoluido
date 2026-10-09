#!/usr/bin/env node
/**
 * O QR CODE do PIX de apoio, gerado a partir do payload — e de mais nada.
 *
 * O apoio ao projeto é opcional e voluntário. O que este roteiro produz é a
 * imagem que alguém aponta a câmera para doar; o valor é livre, porque o
 * payload não declara valor (o campo 54 do BR Code não existe nele).
 *
 * ## Por que o payload mora num arquivo, e não aqui dentro
 *
 * Porque ele aparece em DOIS lugares para quem lê: o QR que se aponta a câmera
 * e o texto que se copia e cola. Dois lugares com o mesmo dado escrito à mão é
 * a segunda verdade mais cara que este repositório conhece — e aqui ela não
 * produziria um rótulo errado, produziria dinheiro indo para o lugar errado ou
 * para lugar nenhum. `docs/pix-payload.txt` é a fonte; `gate:pix` confere que
 * o README cita exatamente ela, e que o CRC do próprio payload fecha.
 *
 * ## O que este roteiro NÃO faz
 *
 * Não inventa, corrige nem "melhora" o payload. Um BR Code carrega um CRC-16
 * sobre todo o resto: mudar um caractere que seja — a chave, o nome, a cidade —
 * invalida o código inteiro, e quem escaneasse receberia um erro do banco. O
 * payload entra byte a byte como o titular o forneceu.
 *
 * Uso: node scripts/build-pix-qr.mjs
 * Precisa de `segno` no Python: `pip install segno --break-system-packages`.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const origem = resolve(raiz, 'docs/pix-payload.txt')
const destino = resolve(raiz, 'docs/images/pix-qr.png')

const payload = readFileSync(origem, 'utf8').trim()

const roteiro = `
import sys
import segno

payload, destino = sys.argv[1], sys.argv[2]

# CORREÇÃO DE ERRO em nível M: um QR impresso, amassado ou fotografado de lado
# continua legível com cerca de 15% do módulo danificado. Nível L economizaria
# pixels num código que ninguém vai imprimir pequeno; nível H o deixaria denso
# demais para uma câmera de celular antiga a meio metro de distância.
codigo = segno.make(payload, error='m')

# Fundo BRANCO e módulos escuros, sempre — e não os tokens do tema.
# A câmera lê contraste, não identidade visual: um QR grafite sobre grafite é
# bonito na tela escura e não é lido por leitor nenhum.
codigo.save(destino, scale=8, border=4, dark='#111418', light='#ffffff')
print('PIX_QR=PASS destino=%s modulos=%dx%d' % (destino, codigo.symbol_size(scale=1, border=0)[0], codigo.symbol_size(scale=1, border=0)[1]))
`

try {
  process.stdout.write(execFileSync('python3', ['-c', roteiro, payload, destino], { encoding: 'utf8' }))
} catch (erro) {
  process.stderr.write(`${String(erro.stdout ?? '')}${String(erro.stderr ?? erro.message)}\n`)
  process.stderr.write('Falta `segno`? `pip install segno --break-system-packages`\n')
  process.exitCode = 1
}
