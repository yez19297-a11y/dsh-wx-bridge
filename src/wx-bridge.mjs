#!/usr/bin/env node
// 微信 ↔ 家的中间那一段桥（含微信个人号本身）。
//
//   外面 → 家：微信来消息 → POST 桥的 sayPath，等同主人自己说的话
//   家 → 外面：我的回复/主动找人/busy → outlets 推到 /push → 微信发出去
//
// 微信那头走腾讯 iLink 的 HTTP 接口（照 AstrBot 的 weixin_oc 适配器写的），
// 扫码登录、长轮询收、直接发。不需要 OpenClaw、不需要 docker。

import { createServer } from 'node:http'
import { createHash, createHmac } from 'node:crypto'
import { readFileSync, appendFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { WeixinOC } from './weixin-oc.mjs'

const WORLD = process.env.WORLD_DIR || '/root/.dsh/worlds/default'
const DIR = process.env.WX_BRIDGE_DIR || join(WORLD, 'room', 'wx-bridge')
const BRIDGE_FILE = join(WORLD, 'bridge.json')
const OUTBOX = join(DIR, 'outbox.jsonl')
const SEEN = join(DIR, 'seen.json')
const STATE = join(DIR, 'wx-state.json')
const QR_DIR = join(DIR, 'qr')
const PORT = Number(process.env.WX_BRIDGE_PORT || 18123)
const HOST = '127.0.0.1'

mkdirSync(DIR, { recursive: true })

const LOGFILE = join(DIR, 'bridge.log')

function log(...a) {
  const line = new Date().toISOString() + ' ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
  console.log(line)
  try { appendFileSync(LOGFILE, line + '\n') } catch {}
}

// ── 桥：DSH 那头 ──────────────────────────────────────────────
function readBridge() {
  const b = JSON.parse(readFileSync(BRIDGE_FILE, 'utf8'))
  if (!b.origin || !b.sayPath || !b.token) throw new Error('bridge.json 不完整')
  return b
}

// dsh-go 给网页加了道门禁：外部请求要带它签过名的浏览器 cookie。
// 签名密钥在 DSH 自己的 .credentials.yaml 里，用同一把签一个，等于本机程序自己人。
function signCookie(authority) {
  const raw = readFileSync(join(process.env.DSH_HOME || '/root/.dsh', '.credentials.yaml'), 'utf8')
  const block = raw.split('client-connection/browser-session:')[1] || ''
  const m = block.match(/secret:\s*([A-Za-z0-9_-]{43,})/)
  if (!m) throw new Error('凭据里没找到 browser-session 的 secret')
  const secret = Buffer.from(m[1], 'base64url')
  const name = 'dsh-auth-' + createHash('sha256').update(authority).digest('base64url')
  const now = Date.now()
  const payload = { version: 1, authority, issuedAt: now, expiresAt: now + 30 * 864e5 }
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = createHmac('sha256', secret).update(body).digest('base64url')
  return `${name}=v1.${body}.${sig}`
}

async function sayIntoHome(text) {
  const b = readBridge()
  const authority = new URL(b.origin).host
  const res = await fetch(new URL(b.sayPath, b.origin).href, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-world-token': b.token, cookie: signCookie(authority) },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(15000),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`桥回了 ${res.status}：${body.error || ''}`)
  return body
}

// ── 队列：我的话往外走 ────────────────────────────────────────
function loadSeen() {
  try { return JSON.parse(readFileSync(SEEN, 'utf8')).seq ?? 0 } catch { return 0 }
}
let seq = loadSeen()

function enqueue(item) {
  const row = { seq: ++seq, at: new Date().toISOString(), ...item }
  appendFileSync(OUTBOX, JSON.stringify(row) + '\n')
  writeFileSync(SEEN, JSON.stringify({ seq }))
  return row
}

function readQueued(afterSeq = 0) {
  if (!existsSync(OUTBOX)) return []
  return readFileSync(OUTBOX, 'utf8')
    .split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l) } catch { return null } })
    .filter((r) => r && r.seq > afterSeq)
}

// ── 微信那头 ─────────────────────────────────────────────────
const MEDIA = join(DIR, 'media')
const wx = new WeixinOC(STATE, MEDIA)
let lastPeer = wx.state.lastPeer || Object.keys(wx.contextTokens)[0] || null
let wxOnline = false
let wxError = ''

function remember(peer) {
  if (!peer) return
  lastPeer = peer
  wx.state.lastPeer = peer
  wx.save()
}

// 长轮询：一直在那儿等着，有新消息就送进家。
async function wechatLoop() {
  for (;;) {
    if (!wx.loggedIn) {
      wxOnline = false
      await new Promise((r) => setTimeout(r, 5000))
      continue
    }
    try {
      wxOnline = true
      const msgs = await wx.pollUpdates(35000)
      wxError = ''
      for (const m of msgs) queueIncoming(m)
    } catch (e) {
      // 长轮询没消息时超时是正常的，不算坏事——但也要喘口气，
      // 不然一直超时会变成死循环，把进程烧死（上午就是这么断的）
      const benign = /aborted|timeout|timed out/i.test(e.message)
      if (!benign) {
        wxOnline = false
        wxError = e.message
        log('微信轮询出错', e.message.slice(0, 120))
      }
      await new Promise((r) => setTimeout(r, benign ? 1000 : 5000))
    }
  }
}

// 连发几条就攒成一条再进家：桥只跟最后一条话的回复，一条一问会漏掉前面的。
const BATCH_MS = Number(process.env.WX_BATCH_MS || 5000)
let pending = []
let pendingTimer = null

// 让对方那边看到「正在输入」。微信的这个状态过几秒自己会消失，所以要一直续。
let typingTimer = null
let typingPeer = null
let typingSince = 0

function startTyping(peer) {
  if (!peer) return
  if (typingPeer === peer && typingTimer) { typingSince = Date.now(); return }
  stopTyping()
  typingPeer = peer
  typingSince = Date.now()
  void wx.setTyping(peer, true).catch(() => {})
  typingTimer = setInterval(() => {
    if (Date.now() - typingSince > 120000) return stopTyping()
    void wx.setTyping(peer, true).catch(() => {})
  }, 5000)
}

function stopTyping() {
  if (typingTimer) clearInterval(typingTimer)
  typingTimer = null
  const peer = typingPeer
  typingPeer = null
  if (peer) void wx.setTyping(peer, false).catch(() => {})
}

function queueIncoming(m) {
  remember(m.from)
  startTyping(m.from)
  log('微信 ←', m.from.slice(0, 8), JSON.stringify(m.text).slice(0, 60))
  pending.push(m)
  if (pendingTimer) clearTimeout(pendingTimer)
  pendingTimer = setTimeout(() => { void flushIncoming() }, BATCH_MS)
}

async function flushIncoming() {
  pendingTimer = null
  const batch = pending.splice(0)
  if (!batch.length) return
  let text = batch.map((m) => m.text).join('\n')
  if ([...text].length > 1900) text = [...text].slice(0, 1890).join('') + '…'
  try {
    // 给屋子这边标一个来源：一眼就能分清这句是从微信来的，还是 App 里直接说的。
    // 他微信那头看到的仍然是自己的原文，不受影响。
    await sayIntoHome('〔微信〕' + text)
  } catch (e) {
    log('送进家失败', e.message)
  }
}

// 我的话发到微信。发不出去就留着，下一条来了再一起试。
// 图：先把文件传到微信 CDN，再发一条 image_item 指过去。
async function pushToWechat(row) {
  if (!wx.loggedIn || !lastPeer) throw new Error('微信还没登录，或者对方还没发过消息')
  const text = row.text || ''
  // 文件（mp3、pdf…）：微信那边是个能点开的附件
  if (row.file) {
    if (!existsSync(row.file)) throw new Error('文件不在了：' + row.file)
    await wx.sendFile(lastPeer, row.file, text)
    return { kind: 'file' }
  }
  const images = [ ...(row.images || []) ]
  if (row.image) images.unshift(row.image)
  if (!images.length) {
    if (!text) throw new Error('没有可发的内容')
    await wx.sendText(lastPeer, text)
    return { kind: 'text' }
  }
  let sent = 0
  for (let i = 0; i < images.length; i++) {
    const path = images[i]
    if (!existsSync(path)) throw new Error('图不在了：' + path)
    // 只有第一张带上那句话，剩下的纯图
    await wx.sendImage(lastPeer, path, i === 0 ? text : undefined)
    sent++
  }
  return { kind: 'image', count: sent }
}

// ── HTTP ────────────────────────────────────────────────────
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > 64 * 1024) throw new Error('body too large')
    chunks.push(c)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

const recentPushes = []

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`)
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      let bridge = null
      try { bridge = readBridge() } catch (e) { bridge = { error: String(e.message) } }
      return send(res, 200, {
        ok: !!bridge?.token,
        port: PORT,
        home: { ok: !!bridge?.token, name: bridge?.name, error: bridge?.error },
        wechat: { loggedIn: wx.loggedIn, online: wxOnline, peer: lastPeer ? lastPeer.slice(0, 8) + '…' : null, error: wxError || null },
      })
    }

    if (req.method === 'GET' && url.pathname === '/outbox') {
      return send(res, 200, { ok: true, items: readQueued(Number(url.searchParams.get('after') ?? 0)) })
    }

    // 外面 → 家（手动测试、或者别的程序送话）
    if (req.method === 'POST' && url.pathname === '/in') {
      const body = JSON.parse((await readBody(req)) || '{}')
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (!text) return send(res, 400, { ok: false, error: 'text 不能为空' })
      if ([...text].length > 2000) return send(res, 400, { ok: false, error: 'text 太长了' })
      const r = await sayIntoHome(text)
      return send(res, 200, { ok: true, id: r.id })
    }

    // 家 → 外面（dsh-world 的 outlets 推过来，或者 App 那边的镜像插件推过来）
    if (req.method === 'POST' && url.pathname === '/push') {
      const item = JSON.parse((await readBody(req)) || '{}')
      if (!item.text && !item.image && !item.file && !item.images?.length) return send(res, 200, { ok: true, skipped: true })
      // 桥和镜像会推同一句话，去个重。
      // 但两边送来的文本不一定一模一样：outlets 那条把 markdown 符号剥掉了，
      // 镜像那条是原文，拿去直接比会永远对不上，同一条话就发两遍（2026-11-22 踩到）。
      // 所以先规范化再比。
      const normalize = (s) =>
        String(s || '')
          .replace(/[`*_~#>]/g, '')
          .replace(/\s+/g, ' ')
          .trim()
      const key = item.text
        ? normalize(item.text)
        : (item.image || item.file || (item.images || []).join(',') || '')
      const now = Date.now()
      if (recentPushes.find((r) => r.text === key && now - r.at < 15000)) {
        return send(res, 200, { ok: true, skipped: 'duplicate' })
      }
      recentPushes.push({ text: key, at: now })
      if (recentPushes.length > 60) recentPushes.shift()
      const row = { kind: item.kind || 'reply', text: item.text || '', images: item.images || [], image: item.image, file: item.file, name: item.name }
      try {
        const result = await pushToWechat(row)
        stopTyping()
        log('微信 →', result.kind === 'image' ? `[图 ${result.count}] ${JSON.stringify(row.text).slice(0, 40)}` : JSON.stringify(row.text).slice(0, 60))
        return send(res, 200, { ok: true, sent: true, kind: result.kind })
      } catch (e) {
        enqueue(row)
        log('没发出去，先排队：', e.message.slice(0, 80))
        return send(res, 200, { ok: true, sent: false, queued: true, reason: e.message })
      }
    }

    // 扫码登录：申请二维码
    if (req.method === 'POST' && url.pathname === '/login') {
      mkdirSync(QR_DIR, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const qr = await wx.requestQr(join(QR_DIR, `qr-${stamp}.png`))
      log('二维码已生成', qr.qrcode)
      return send(res, 200, { ok: true, qrcode: qr.qrcode, link: qr.link, imagePath: qr.imagePath })
    }

    // 扫码登录：问一次状态（长轮询，没扫就挂着）
    if (req.method === 'GET' && url.pathname === '/login/status') {
      const r = await wx.waitQr(Number(url.searchParams.get('wait') ?? 20000))
      return send(res, 200, { ok: true, status: r.status, loggedIn: wx.loggedIn })
    }

    return send(res, 404, { ok: false, error: 'no such path' })
  } catch (e) {
    log('错误', e.message)
    return send(res, 500, { ok: false, error: String(e.message) })
  }
})

server.listen(PORT, HOST, () => {
  log(`wx-bridge 起在 http://${HOST}:${PORT}`)
  void wechatLoop()
})
