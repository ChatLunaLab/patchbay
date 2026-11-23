import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { patchPath } from '../src/manifest.ts'
import { applyPatchText } from '../src/patch.ts'

function writeShim(dir: string, name: string, code: string): void {
  const pkgDir = join(dir, 'node_modules', name)
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name, type: 'module', main: 'index.js' }))
  writeFileSync(join(pkgDir, 'index.js'), code)
}

test('@cordisjs/plugin-http: WebSocket enforces a 5s close deadline for silent peers, preserves graceful close, proxies and hooks', { timeout: 30_000 }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'patchbay-http-ws-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const target = join(dir, 'pkg')
  mkdirSync(target)
  const archive = execFileSync('npm', ['pack', '@cordisjs/plugin-http@1.5.2', '--pack-destination', dir, '--silent'], { encoding: 'utf8' }).trim()
  execFileSync('tar', ['-xzf', join(dir, archive), '-C', target, '--strip-components=1'])
  applyPatchText(target, readFileSync(patchPath({ name: '@cordisjs/plugin-http', version: '1.5.2' }), 'utf8'))

  writeShim(target, 'cordis', `
    const resolveIntercept = Symbol('resolveIntercept')
    export class Service {
      static invoke = Symbol('invoke')
      static extend = Symbol('extend')
      static resolveIntercept = resolveIntercept
      constructor(ctx) { this.ctx = ctx }
      [resolveIntercept]() { return {} }
    }
  `)
  writeShim(target, 'cosmokit', `
    export const Binary = { fromBase64: (s) => Buffer.from(s, 'base64') }
    export const defineProperty = (obj, key, value) => Object.defineProperty(obj, key, { value, configurable: true, writable: true })
    export const isNullable = (v) => v === null || v === undefined
  `)
  writeShim(target, '@cordisjs/fetch-file', 'export default async function fetchFile() { return new Response(null, { status: 404 }) }\n')
  writeShim(target, 'schemastery', `
    const chain = () => new Proxy(() => chain(), { get: () => () => chain() })
    export default chain()
  `)

  const runner = join(dir, 'run.mjs')
  const httpUrl = pathToFileURL(join(target, 'lib/index.js')).href
  writeFileSync(runner, `
    import assert from 'node:assert/strict'
    import { createHash } from 'node:crypto'
    import http from 'node:http'
    import { Http } from ${JSON.stringify(httpUrl)}

    function startWsServer(mode) {
      return new Promise((resolve) => {
        const sockets = new Set()
        const server = http.createServer()
        server.on('upgrade', (req, sock) => {
          sockets.add(sock)
          sock.on('close', () => sockets.delete(sock))
          const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
          sock.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n')
          if (mode === 'graceful') sock.once('data', () => sock.end(Buffer.from([0x88, 0x02, 0x0f, 0xa0])))
        })
        server.listen(0, '127.0.0.1', () => resolve({
          url: 'ws://127.0.0.1:' + server.address().port,
          close: () => { for (const s of sockets) s.destroy(); return new Promise((r) => server.close(r)) }
        }))
      })
    }

    let customHook
    const effects = []
    const ctx = {
      on: () => () => {},
      effect(fn) {
        const dispose = fn()
        effects.push(dispose)
        return () => { const i = effects.indexOf(dispose); if (i >= 0) effects.splice(i, 1) }
      },
      logger: () => ({ debug() {}, warn() {}, error() {} }),
      waterfall(_self, event, url, init, config, next) {
        if (event === 'http/websocket' && customHook) return customHook(url, init, config, next)
        return next()
      }
    }
    const client = new Http(ctx, {})
    const silent = await startWsServer('silent')
    const graceful = await startWsServer('graceful')

    try {
      // 1. Silent peer: close(4000) hits the 5s deadline, destroys only that stream, emits close(1006).
      const ws1 = client.ws(silent.url)
      await new Promise((r) => ws1.addEventListener('open', r, { once: true }))
      let closeCount = 0
      const closed1 = new Promise((r) => ws1.addEventListener('close', (e) => { closeCount++; r({ code: e.code, wasClean: e.wasClean }) }))
      const t0 = Date.now()
      ws1.close(4000, 'zombied connection')
      const res1 = await closed1
      const elapsed1 = Date.now() - t0
      assert.equal(res1.code, 1006)
      assert.equal(res1.wasClean, false)
      assert.equal(closeCount, 1)
      assert.ok(elapsed1 >= 4500 && elapsed1 < 8000, 'expected ~5s deadline, got ' + elapsed1 + 'ms')

      // 2. Subsequent connection on the same shared dispatcher works + graceful close cancels timer.
      const ws2 = client.ws(graceful.url)
      await new Promise((r) => ws2.addEventListener('open', r, { once: true }))
      const closed2 = new Promise((r) => ws2.addEventListener('close', (e) => r({ code: e.code, wasClean: e.wasClean }), { once: true }))
      const t2 = Date.now()
      ws2.close(4000, 'normal')
      const res2 = await closed2
      assert.equal(res2.code, 4000)
      assert.equal(res2.wasClean, true)
      assert.ok(Date.now() - t2 < 2000)

      // 3. Custom http/websocket hook returning a ws-like socket with .terminate() is terminated on deadline.
      let terminated = false
      let closeListener
      customHook = () => ({
        readyState: 1,
        close() { this.readyState = 2 },
        terminate() { terminated = true; this.readyState = 3; closeListener?.() },
        addEventListener(type, fn) { if (type === 'close') closeListener = fn }
      })
      const fakeWs = client.ws(silent.url)
      const closed3 = new Promise((r) => fakeWs.addEventListener('close', r))
      const t3 = Date.now()
      fakeWs.close(4000, 'zombied')
      await closed3
      assert.equal(terminated, true)
      assert.ok(Date.now() - t3 >= 4500)
    } finally {
      await silent.close()
      await graceful.close()
    }
  `)

  execFileSync(process.execPath, ['--expose-internals', runner], { stdio: 'inherit' })
})
