import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parse } from 'yaml'
import { applyPatchText } from '../src/patch.ts'
import { loadManifest, patchFileName } from '../src/manifest.ts'
import { detect, STATE_DIR, sync, type PackageJson } from '../src/sync.ts'

function project(pkg: PackageJson, files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'patchbay-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  return dir
}

function readJson(path: string): PackageJson {
  return JSON.parse(readFileSync(path, 'utf8'))
}

const manifest = loadManifest()
const koishi = manifest.patches.find((entry) => entry.name === '@koishijs/core')!

test('detect prefers packageManager, then lockfiles', () => {
  assert.equal(detect(project({ packageManager: 'pnpm@10.0.0' }, { 'yarn.lock': '' })), 'pnpm')
  assert.equal(detect(project({}, { 'pnpm-lock.yaml': '' })), 'pnpm')
  assert.equal(detect(project({}, { 'yarn.lock': '__metadata:\n  version: 8\n' })), 'yarn')
  assert.equal(detect(project({}, { 'package-lock.json': '{}' })), 'npm')
  assert.throws(() => detect(project({ packageManager: 'yarn@1.22.22' })), /Yarn 1/)
  assert.throws(() => detect(project({}, { 'yarn.lock': '# yarn lockfile v1\n' })), /Yarn 1/)
})

test('sync copies every patch and the manifest into .patchbay', () => {
  const dir = project({})
  sync(dir, { pm: 'yarn' })
  for (const entry of manifest.patches) readFileSync(join(dir, STATE_DIR, patchFileName(entry)))
  assert.deepEqual(readJson(join(dir, STATE_DIR, 'patchbay.json')), manifest)
})

test('yarn: resolutions point at the copied patches, aliases included', () => {
  const dir = project({ resolutions: { 'left-pad': '1.3.0' } })
  sync(dir, { pm: 'yarn' })
  const { resolutions } = readJson(join(dir, 'package.json'))
  const spec = `patch:@koishijs/core@npm%3A${koishi.version}#~/.patchbay/${patchFileName(koishi)}`
  assert.equal(resolutions?.['@koishijs/core'], spec)
  assert.equal(resolutions?.['koishi'], spec)
  assert.equal(resolutions?.['left-pad'], '1.3.0')
})

test('pnpm: overrides and patchedDependencies land in pnpm-workspace.yaml, comments kept', () => {
  const dir = project({}, { 'pnpm-workspace.yaml': '# keep me\nonlyBuiltDependencies:\n  - esbuild\n' })
  sync(dir, { pm: 'pnpm' })
  const text = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')
  assert.match(text, /# keep me/)
  const config = parse(text)
  assert.deepEqual(config.onlyBuiltDependencies, ['esbuild'])
  assert.equal(config.overrides['koishi'], `npm:@koishijs/core@${koishi.version}`)
  assert.equal(config.overrides['@koishijs/core'], koishi.version)
  assert.equal(config.patchedDependencies[`@koishijs/core@${koishi.version}`], `.patchbay/${patchFileName(koishi)}`)
  assert.equal(config.allowUnusedPatches, true)
})

test('npm: overrides, direct dependencies pinned to the same spec, postinstall appended once', () => {
  const dir = project({ dependencies: { koishi: '^4.18.0', cordis: '^4.0.0-rc.12' }, scripts: { postinstall: 'echo hi' } })
  sync(dir, { pm: 'npm' })
  sync(dir, { pm: 'npm' })
  const pkg = readJson(join(dir, 'package.json'))
  assert.deepEqual(pkg.overrides?.['koishi'], { '.': `npm:@koishijs/core@${koishi.version}`, ...koishi.dependencies })
  assert.equal(pkg.dependencies?.['koishi'], `npm:@koishijs/core@${koishi.version}`)
  assert.equal(pkg.dependencies?.['cordis'], '^4.0.0-rc.12')
  assert.equal(pkg.scripts?.['postinstall'], 'echo hi && patchbay apply')
  const satori = manifest.patches.find((entry) => entry.name === '@satorijs/core')!
  assert.deepEqual(pkg.overrides?.['@satorijs/core'], { '.': satori.version, ...satori.dependencies })
})

test('a resync drops pins the previous manifest wrote', () => {
  const dir = project({})
  mkdirSync(join(dir, STATE_DIR))
  const stale = { patches: [{ name: 'stale-pkg', version: '1.0.0', description: '' }], aliases: {} }
  writeFileSync(join(dir, STATE_DIR, 'patchbay.json'), JSON.stringify(stale))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ resolutions: { 'stale-pkg': 'patch:x' }, overrides: { 'stale-pkg': '1.0.0' } }))
  sync(dir, { pm: 'npm' })
  assert.equal(readJson(join(dir, 'package.json')).overrides?.['stale-pkg'], undefined)
  writeFileSync(join(dir, STATE_DIR, 'patchbay.json'), JSON.stringify(stale))
  sync(dir, { pm: 'yarn' })
  assert.equal(readJson(join(dir, 'package.json')).resolutions?.['stale-pkg'], undefined)
})

test('applyPatchText applies, reverses, and leaves files alone when a hunk does not fit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'patchbay-'))
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
  const patch = [
    'diff --git a/a.txt b/a.txt',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,2 +1,2 @@',
    ' one',
    '-two',
    '+three',
    'diff --git a/new.txt b/new.txt',
    '--- /dev/null',
    '+++ b/new.txt',
    '@@ -0,0 +1 @@',
    '+created',
    ''
  ].join('\n')
  applyPatchText(dir, patch)
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'one\nthree\n')
  assert.equal(readFileSync(join(dir, 'new.txt'), 'utf8'), 'created\n')
  assert.throws(() => applyPatchText(dir, patch), /does not apply to a\.txt/)
  applyPatchText(dir, patch, { reverse: true })
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'one\ntwo\n')
  assert.throws(() => readFileSync(join(dir, 'new.txt')))
})
