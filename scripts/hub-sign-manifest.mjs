// Publisher tool for signed integration manifests (D16 / ADR-031).
//
//   node scripts/hub-sign-manifest.mjs keygen  <private-key.pem>            # writes the private key (0600) and prints the public key
//   node scripts/hub-sign-manifest.mjs sign    <manifest.json> <private-key.pem> [--replace] [--out signed.json]
//   node scripts/hub-sign-manifest.mjs pubkey  <private-key.pem>            # prints the public key to register in the Studio
//
// The private key is read from a file you control (or from the DZ23_HUB_PRIVATE_KEY_PEM env)
// and never printed. The public key is what the Studio operator puts in DZ23_HUB_PUBLISHER_KEYS.
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [command, ...rest] = process.argv.slice(2)
const flags = new Set(rest.filter(arg => arg.startsWith('--') && !arg.includes('=')))
const outIndex = rest.indexOf('--out')
const outPath = outIndex === -1 ? undefined : rest[outIndex + 1]
const positional = rest.filter((arg, index) => !arg.startsWith('--') && rest[index - 1] !== '--out')
const lib = await import(pathToFileURL(resolve(process.cwd(), 'plugins/integration-hub/lib/signing.js')).href)
  .catch(() => { fail('build the plugin first: pnpm --dir plugins/integration-hub build') })

if (command === 'keygen') {
  const [target] = positional
  if (target === undefined) fail('usage: keygen <private-key.pem>')
  if (existsSync(target)) fail(`refusing to overwrite ${target}`)
  const pair = lib.generatePublisherKeyPair()
  await writeFile(target, pair.privateKeyPem, { mode: 0o600, flag: 'wx' })
  process.stdout.write(`private key written to ${target} (keep it in your vault; never commit it)\npublic key (SPKI base64):\n${pair.publicKeyBase64}\n`)
} else if (command === 'pubkey') {
  process.stdout.write(`${lib.publicKeyFromPrivatePem(await privateKeyPem(positional[0]))}\n`)
} else if (command === 'sign') {
  const [manifestPath, keyPath] = positional
  if (manifestPath === undefined) fail('usage: sign <manifest.json> <private-key.pem> [--replace] [--out signed.json]')
  let manifest
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')) } catch { fail(`cannot read ${manifestPath} as JSON`) }
  let signed
  try { signed = lib.signManifest(manifest, await privateKeyPem(keyPath), { replace: flags.has('--replace') }) } catch (error) { fail(error instanceof Error ? error.message : String(error)) }
  const output = `${JSON.stringify(signed, null, 2)}\n`
  if (outPath === undefined) process.stdout.write(output)
  else { await writeFile(outPath, output, { flag: flags.has('--replace') ? 'w' : 'wx' }); process.stdout.write(`signed manifest written to ${outPath}\n`) }
} else {
  fail('commands: keygen | pubkey | sign')
}

async function privateKeyPem(path) {
  if (path !== undefined) return readFile(path, 'utf8')
  if (process.env.DZ23_HUB_PRIVATE_KEY_PEM) return process.env.DZ23_HUB_PRIVATE_KEY_PEM
  fail('private key required: pass the PEM file path or set DZ23_HUB_PRIVATE_KEY_PEM')
}

function fail(message) { process.stderr.write(`${message}\n`); process.exit(1) }
