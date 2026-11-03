#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { apply } from './apply.ts'
import { loadManifest } from './manifest.ts'
import { isPackageManager, sync } from './sync.ts'

const usage = `usage: patchbay <command> [--dir <project>]

  sync [--pm yarn|pnpm|npm]  copy the patches into .patchbay/ and wire them into the package manager
  apply                      patch node_modules in place (npm postinstall; yarn and pnpm patch on install)
  list                       print the patched packages`

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { dir: { type: 'string', default: process.cwd() }, pm: { type: 'string' } }
})

const [command] = positionals
if (command === 'sync') {
  if (values.pm !== undefined && !isPackageManager(values.pm)) throw new Error(`--pm must be yarn, pnpm or npm`)
  const pm = sync(values.dir, values.pm === undefined ? {} : { pm: values.pm })
  console.log(`patchbay: wired ${loadManifest().patches.length} patches into ${pm}; run \`${pm} install\``)
} else if (command === 'apply') {
  for (const path of apply(values.dir)) console.log(`patchbay: patched ${path}`)
} else if (command === 'list') {
  for (const entry of loadManifest().patches) console.log(`${entry.name}@${entry.version}  ${entry.description}`)
} else {
  console.error(usage)
  process.exitCode = 1
}
