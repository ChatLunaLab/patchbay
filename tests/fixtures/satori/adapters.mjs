// Runs the adapters from v2-mirror#14 and boilerplate#12/#13 against local fake servers.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { Context, Logger } from 'cordis'
import { Http } from '@cordisjs/plugin-http'
import { Satori } from '@satorijs/core'

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))
const load = async (name) => {
  const mod = await import(name)
  return mod.default?.default ?? mod.default ?? mod
}

const requests = []
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c)).on('end', () => {
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body })
    res.writeHead(200, { 'content-type': 'application/json' })
    if (req.url === '/v1/message.create') return res.end('[{"id":"m1"}]')
    if (req.url === '/users/@me') return res.end('{"id":"99","username":"qqbot","avatar":""}')
    if (req.url.startsWith('/v2/groups/')) return res.end('{"id":"q1","timestamp":0}')
    res.end('{}')
  })
})
const sockets = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit('connection', ws, req)))
sockets.on('connection', (ws, req) => {
  if (req.url === '/v1/events') {
    ws.on('message', (raw) => {
      const { op } = JSON.parse(raw)
      if (op !== 3) return
      ws.send(JSON.stringify({ op: 4, body: { logins: [{ sn: 1, platform: 'onebot', user: { id: '42', name: 'bot' }, status: 1 }] } }))
      setTimeout(() => ws.send(JSON.stringify({
        op: 0,
        body: { sn: 1, type: 'message-created', platform: 'onebot', self_id: '42', timestamp: Date.now(), channel: { id: 'c1', type: 0 }, user: { id: 'u1' }, message: { id: 'x', content: 'hello' } }
      })), 20)
    })
    return
  }
  // QQ gateway
  ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } }))
  ws.on('message', (raw) => {
    const { op, d } = JSON.parse(raw)
    if (op !== 2) return
    assert.equal(d.token, 'QQBot token-1')
    ws.send(JSON.stringify({ op: 0, s: 1, t: 'READY', d: { version: 1, session_id: 's1', user: { id: '99', username: 'qqbot', bot: true }, shard: [0, 1] } }))
  })
})
await new Promise((r) => server.listen(0, r))
const base = `http://127.0.0.1:${server.address().port}`

const root = new Context()
const problems = []
root.logger.exporter({
  colors: 0,
  export: (message) => {
    if (message.type === 'warn' || message.type === 'error') problems.push(`${message.name}: ${Logger.format({ colors: 0 }, message)}`)
  }
})
root.plugin(Http)
root.plugin(Satori)
// bots.qq.com is fixed in the adapter; answer it here.
root.on('http/fetch', async (url, init, config, next) => {
  if (url.host !== 'bots.qq.com') return next()
  return new Response(JSON.stringify({ access_token: 'token-1', expires_in: '7200' }), { headers: { 'content-type': 'application/json' } })
}, { prepend: true })
const messages = []
root.on('message', (session) => messages.push(`${session.platform}:${session.content}`))
await tick()

// v2-mirror#14: adapter-satori starts on ready and joins relative URLs onto its endpoint.
const satori = root.plugin(await load('@satorijs/adapter-satori'), { endpoint: base, token: 't' })
await tick(300)
assert.equal(satori.state, 2, 'adapter-satori fiber is active')
const onebot = root.bots.find((bot) => bot.platform === 'onebot')
assert.ok(onebot, 'adapter-satori bot logged in')
assert.deepEqual(messages, ['onebot:hello'])
assert.deepEqual(await onebot.sendMessage('c1', 'hi'), ['m1'])
assert.equal(requests.at(-1).url, '/v1/message.create')
assert.equal(requests.at(-1).auth, 'Bearer t')

// boilerplate#12 and #13: adapter-qq declares { required, optional }, reads `http(url).data`.
const qq = root.plugin(await load('@satorijs/adapter-qq'), {
  id: '123', secret: 's', type: 'public', endpoint: base + '/', gatewayUrl: base.replace('http', 'ws') + '/gateway', intents: 1 << 25
})
await tick(500)
assert.equal(qq.state, 2, 'adapter-qq fiber is active')
const qqbot = root.bots.find((bot) => bot.platform === 'qq')
assert.ok(qqbot, 'qq bot created')
assert.equal(qqbot.status, 1, 'qq bot online')
assert.equal(qqbot.user.id, '99')
assert.ok(requests.some((r) => r.url === '/users/@me' && r.auth === 'QQBot token-1'), 'REST calls carry the access token')
await qqbot.sendMessage('group-1', 'hi')
assert.ok(requests.some((r) => r.url === '/v2/groups/group-1/messages' && JSON.parse(r.body).content === 'hi'), 'qq message sent')

assert.deepEqual(problems, [])
console.log('adapters ok')
server.close()
process.exit(0)
