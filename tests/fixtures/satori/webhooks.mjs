// Drives the Koa-style webhook routes of several adapters through @cordisjs/plugin-server 1.x.
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import WebSocket from 'ws'
import { Context, Logger } from 'cordis'
import { Http } from '@cordisjs/plugin-http'
import Server from '@cordisjs/plugin-server'
import Timer from '@cordisjs/plugin-timer'
import { Satori } from '@satorijs/core'

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms))
const load = async (name) => {
  const mod = await import(name)
  return mod.default?.default ?? mod.default ?? mod
}

// Plays the OneBot implementation's HTTP API.
const onebotApi = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 42, nickname: 'bot' } }))
})
await new Promise((r) => onebotApi.listen(0, r))

const root = new Context()
// Importing koishi makes `session` events consult `ctx.filter`, which a Koishi app would provide.
root.provide('filter')
root.set('filter', () => true)
const problems = []
root.logger.exporter({
  colors: 0,
  export: (message) => {
    if (message.type === 'warn' || message.type === 'error') problems.push(`${message.name}: ${Logger.format({ colors: 0 }, message)}`)
  }
})
root.plugin(Http)
root.plugin(Server, { host: '127.0.0.1', port: 0, baseUrl: 'https://bot.example' })
root.plugin(Timer)
root.plugin(Satori)
const platform = []
root.on('http/fetch', async (url, init, config, next) => {
  if (url.hostname === '127.0.0.1') return next()
  platform.push({ url: url.href, body: init.body })
  const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
  if (url.host === 'bots.qq.com') return json({ access_token: 'token-1', expires_in: '7200' })
  if (url.host === 'api.sgroup.qq.com') return json({ id: '99', username: 'qqbot', avatar: '' })
  if (url.pathname.endsWith('/getMe')) return json({ ok: true, result: { id: 1, is_bot: true, first_name: 'tg', username: 'tg' } })
  if (url.pathname.endsWith('/getUserProfilePhotos')) return json({ ok: true, result: { total_count: 0, photos: [] } })
  if (url.pathname.endsWith('/getFile')) return json({ ok: true, result: { file_id: 'f', file_path: 'photos/a.png' } })
  if (url.pathname.startsWith('/file/')) return new Response('png-bytes', { headers: { 'content-type': 'image/png' } })
  if (url.host === 'api.telegram.org') return json({ ok: true, result: true })
  if (url.pathname.endsWith('/auth.test')) return json({ ok: true, user_id: 'U1', user: 'slackbot' })
  return json({ ok: true })
}, { prepend: true })
const messages = []
root.on('message', (session) => messages.push(`${session.platform}:${session.content}`))
await tick()
const base = `http://127.0.0.1:${root.server.port}`
const post = (path, body, headers = {}) => fetch(base + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body)
})

// adapter-onebot over HTTP: headers + `ctx.body` in, a bare status out.
root.plugin(await load('koishi-plugin-adapter-onebot'), { protocol: 'http', selfId: '42', endpoint: `http://127.0.0.1:${onebotApi.address().port}` })
await tick(300)
const event = { post_type: 'message', message_type: 'private', sub_type: 'friend', message_id: 1, user_id: 7, self_id: 42, time: 0, message: 'hello', raw_message: 'hello', sender: { user_id: 7, nickname: 'u' } }
assert.equal((await post('/onebot', event, { 'x-self-id': '42' })).status, 204)
assert.equal((await post('/onebot', event, { 'x-self-id': '1' })).status, 403)
await tick()
assert.ok(messages.includes('onebot:hello'), 'onebot http event dispatched')

// adapter-onebot as a reverse WebSocket server: the handshake headers reach the handler.
root.plugin(await load('koishi-plugin-adapter-onebot'), { protocol: 'ws-reverse', selfId: '43', path: '/onebot-ws' })
await tick(200)
const socket = new WebSocket(base.replace('http', 'ws') + '/onebot-ws', { headers: { 'x-client-role': 'Universal', 'x-self-id': '43' } })
const action = await new Promise((resolve, reject) => {
  socket.once('message', (raw) => resolve(JSON.parse(raw)))
  socket.once('close', (code, reason) => reject(new Error(`closed ${code} ${reason}`)))
})
assert.equal(action.action, 'get_login_info')
socket.close()

// adapter-qq webhook: the parsed body and a JSON response for the address check.
root.plugin(await load('@satorijs/adapter-qq'), { id: '123', secret: 'abcdefghijklmnopqrstuvwxyz012345', type: 'public', protocol: 'webhook', path: '/qq' })
await tick(300)
const verified = await post('/qq', { op: 13, d: { plain_token: 'p', event_ts: '1' } }, { 'x-bot-appid': '123' })
assert.equal(verified.status, 200)
const { plain_token, signature } = await verified.json()
assert.equal(plain_token, 'p')
assert.match(signature, /^[0-9a-f]{128}$/)
assert.equal((await post('/qq', { op: 13, d: {} }, { 'x-bot-appid': '0' })).status, 403)

// adapter-telegram webhook: setWebhook targets selfUrl, the query carries the token.
root.plugin(await load('@satorijs/adapter-telegram'), { protocol: 'server', token: '1:t' })
await tick(300)
const hook = platform.find((item) => item.url.endsWith('/setWebhook'))
assert.equal(JSON.parse(hook.body).url, 'https://bot.example/telegram?token=1:t')
const update = { update_id: 1, message: { message_id: 1, date: 0, chat: { id: 5, type: 'private' }, from: { id: 5, first_name: 'u' }, text: 'hi tg' } }
const answered = await post('/telegram?token=1:t', update)
assert.equal(await answered.text(), 'OK')
assert.equal((await post('/telegram?token=1:x', update)).status, 403)
await tick()
assert.ok(messages.includes('telegram:hi tg'), 'telegram update dispatched')
// The file route is registered as `/:file+`, which path-to-regexp 8 only accepts as a wildcard.
const file = await fetch(base + '/telegram/1/photos/a.png')
assert.equal(file.headers.get('content-type'), 'image/png')
assert.equal(await file.text(), 'png-bytes')

// adapter-slack: the HMAC covers the unparsed body.
root.plugin(await load('@satorijs/adapter-slack'), { protocol: 'http', token: 't', botToken: 'b', signing: 'secret' })
await tick(300)
const raw = JSON.stringify({ type: 'url_verification', challenge: 'c1' })
const timestamp = String(Math.floor(Date.now() / 1000))
const sign = (body) => 'v0=' + createHmac('sha256', 'secret').update(`v0:${timestamp}:${body}`).digest('hex')
const challenged = await post('/slack', raw, { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': sign(raw) })
assert.deepEqual(await challenged.json(), { challenge: 'c1' })
assert.equal((await post('/slack', raw, { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': sign('x') })).status, 403)

assert.deepEqual(problems, [])
console.log('webhooks ok')
process.exit(0)
