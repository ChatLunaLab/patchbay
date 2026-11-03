// Checks the @satorijs/core patch: inject shapes, ready/dispose, and the Quester facade.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Context } from 'cordis'
import { Http } from '@cordisjs/plugin-http'
import { Satori, Bot } from '@satorijs/core'

const server = createServer((req, res) => {
  if (req.url === '/missing') { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":"nope"}') }
  let body = ''
  req.on('data', (c) => body += c).on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ path: req.url, method: req.method, body }))
  })
})
await new Promise((r) => server.listen(0, r))
const base = `http://127.0.0.1:${server.address().port}`
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))
const log = []

const root = new Context()
root.plugin(Http)
root.plugin(Satori)
await tick()

// 1. { required, optional } inject
const shaped = root.plugin({ name: 'shaped', inject: { required: ['http'], optional: ['server', 'satori'] }, apply(ctx) {
  log.push(['shaped', ctx.server, !!ctx.satori])
} })
await tick()
assert.equal(shaped.state, 2, 'shaped inject plugin activates')
assert.deepEqual(log.shift(), ['shaped', undefined, true])

// 2. ready / dispose
const life = root.plugin({ name: 'life', apply(ctx) {
  ctx.on('ready', () => log.push('ready'))
  ctx.on('dispose', () => log.push('dispose'))
  const off = ctx.on('dispose', () => log.push('never'))
  off()
} })
await tick()
assert.deepEqual(log.splice(0), ['ready'])
life.dispose()
await tick()
assert.deepEqual(log.splice(0), ['dispose'])

// 3. Bot plugin: waits for satori, gets the Quester facade, also when another plugin calls it
class TestBot extends Bot {
  static inject = { required: ['http'] }
  constructor(ctx, config) {
    super(ctx, config, 'test')
    this.http = ctx.http.extend({ endpoint: config.endpoint })
    log.push(['bot', typeof ctx.http.file, typeof ctx.http.isLocal])
  }
  client() { return this.ctx.http }
}
const bot = root.plugin(TestBot, { endpoint: base + '/api/' })
await tick()
assert.equal(bot.state, 2, 'bot activates')
assert.deepEqual(log.shift(), ['bot', 'function', 'function'])
const instance = root.bots[0]
assert.deepEqual(await instance.http.post('/v1/message.create', { a: 1 }), { path: '/api/v1/message.create', method: 'POST', body: '{"a":1}' })
const response = await instance.client()(base + '/x', { method: 'PUT' })
assert.equal(response.status, 200)
assert.equal(response.data.method, 'PUT')
await assert.rejects(instance.client()(base + '/missing'), (e) => Http.Error.is(e) && e.response.status === 404 && e.response.data.error === 'nope')
assert.equal((await instance.client()(base + '/missing', { validateStatus: () => true })).status, 404)
const file = await instance.client().file('data:image/png;base64,aGk=')
assert.equal(file.mime, 'image/png'); assert.equal(file.filename, 'file.png'); assert.equal(Buffer.from(file.data).toString(), 'hi')
assert.equal(await instance.client().isLocal('http://127.0.0.1:1/'), true)
assert.equal(await instance.client().isLocal('https://1.1.1.1/'), false)
assert.equal(instance.client().isError(new Http.Error('x')), true)

// 4. Plain plugins keep the plugin-http client
root.plugin({ name: 'plain', inject: ['http'], async apply(ctx) {
  const raw = await ctx.http(base + '/missing')
  log.push(['plain', typeof raw.json === 'function' && !('data' in raw), raw.status])
} })
await tick(100)
assert.deepEqual(log.shift(), ['plain', true, 404])
console.log('shim ok')
server.close()
process.exit(0)
