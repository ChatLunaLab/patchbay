import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { before, describe, test } from 'node:test'
import { ROOT } from '../src/manifest.ts'

// Real installs against the npm registry; `yarn build` must have produced lib/ first.
const YARN = join(ROOT, '.yarn/releases/yarn-4.18.0.cjs')
const env = { ...process.env, CI: '', YARN_ENABLE_IMMUTABLE_INSTALLS: 'false', npm_config_user_agent: '' }

let tarball = ''
before(() => {
  const out = mkdtempSync(join(tmpdir(), 'patchbay-pack-'))
  const [packed] = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', out], { cwd: ROOT, encoding: 'utf8' })
  )
  tarball = join(out, packed.filename)
})

function project(packageManager?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'patchbay-install-'))
  const pkg = {
    name: 'fixture',
    private: true,
    packageManager,
    dependencies: { '@cordisjs/plugin-http': '^1.5.0', minato: '^3.0.0' },
    devDependencies: { '@chatluna/patchbay': `file:${tarball}` }
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
  return dir
}

function run(dir: string, command: string, args: string[]): string {
  return execFileSync(command, args, { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function assertPatched(dir: string): void {
  assert.match(readFileSync(join(dir, 'node_modules/@cordisjs/plugin-http/lib/index.js'), 'utf8'), /\[this\[Service\.resolveIntercept\]\(\), this\.config, init\]/)
  // `minato` is aliased to the patched @cordisjs/plugin-database.
  assert.match(readFileSync(join(dir, 'node_modules/minato/lib/index.js'), 'utf8'), /if \(name === "database"\) this\.refresh\(\)/)
}

const PATCHBAY = join(ROOT, 'lib/cli.js')

describe('real installs', { timeout: 300_000 }, () => {
  test('yarn', () => {
    const dir = project('yarn@4.18.0')
    writeFileSync(join(dir, '.yarnrc.yml'), `nodeLinker: node-modules\nyarnPath: ${YARN}\n`)
    run(dir, 'node', [PATCHBAY, 'sync'])
    run(dir, 'node', [YARN, 'install'])
    assertPatched(dir)
  })

  test('pnpm', () => {
    const dir = project()
    run(dir, 'node', [PATCHBAY, 'sync', '--pm', 'pnpm'])
    run(dir, 'pnpm', ['install'])
    assertPatched(dir)
  })

  test('npm', () => {
    const dir = project()
    run(dir, 'node', [PATCHBAY, 'sync', '--pm', 'npm'])
    run(dir, 'npm', ['install'])
    assertPatched(dir)
    assert.equal(run(dir, 'npx', ['patchbay', 'apply']), '', 'a second apply finds nothing to do')
  })

  // npm also covers the nested overrides that keep @satorijs/core off cordis 3.
  test('satori adapters run on cordis 4', () => {
    const dir = mkdtempSync(join(tmpdir(), 'patchbay-satori-'))
    const pkg = {
      name: 'fixture',
      private: true,
      type: 'module',
      dependencies: {
        cordis: '4.0.0-rc.12',
        '@cordisjs/plugin-http': '1.5.2',
        '@cordisjs/plugin-server': '1.7.0',
        '@cordisjs/plugin-timer': '1.1.4',
        '@satorijs/core': '4.6.1',
        '@satorijs/adapter-satori': '1.5.1',
        '@satorijs/adapter-qq': '4.14.1',
        '@satorijs/adapter-slack': '2.5.0',
        '@satorijs/adapter-telegram': '4.5.11',
        koishi: '^4.18.0',
        'koishi-plugin-adapter-onebot': '6.9.5',
        undici: '^7.16.0',
        ws: '^8.18.0'
      },
      devDependencies: { '@chatluna/patchbay': `file:${tarball}` }
    }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
    run(dir, 'node', [PATCHBAY, 'sync', '--pm', 'npm'])
    run(dir, 'npm', ['install'])
    assert.throws(() => readFileSync(join(dir, 'node_modules/@satorijs/core/node_modules/cordis/package.json')))
    for (const name of ['shim.mjs', 'adapters.mjs', 'webhooks.mjs']) {
      cpSync(join(ROOT, 'tests/fixtures/satori', name), join(dir, name))
      run(dir, 'node', [name])
    }
  })
})
