// 微信（个人号）协议客户端 —— 照着 AstrBot 的 weixin_oc 适配器抄的。
// 走腾讯 iLink 的 HTTP 接口：扫码登录、长轮询收消息、发消息。不需要 OpenClaw，也不需要 docker。
//
//   GET  /ilink/bot/get_bot_qrcode       → { qrcode, qrcode_img_content }
//   GET  /ilink/bot/get_qrcode_status    → 长轮询，confirmed 时给 bot_token / baseurl / ilink_bot_id
//   POST /ilink/bot/getupdates           → 长轮询收消息（带 get_updates_buf 游标）
//   POST /ilink/bot/sendmessage          → 发消息（要 context_token）

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomInt, randomUUID, randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto'

const BASE = 'https://ilinkai.weixin.qq.com'
const CDN = 'https://novac2c.cdn.weixin.qq.com/c2c'
const QR_API = 'https://api.qrserver.com/v1/create-qr-code/?size=420x420&data='

// 微信的媒体都拿 AES-ECB 加密过，密钥随消息一起发过来。
function aesDecrypt(key, data) {
  const d = createDecipheriv('aes-128-ecb', key, null)
  d.setAutoPadding(false)
  let out = Buffer.concat([d.update(data), d.final()])
  const pad = out[out.length - 1]
  if (pad > 0 && pad <= 16 && out.subarray(-pad).every((b) => b === pad)) out = out.subarray(0, -pad)
  return out
}

// 发出去的媒体要反过来：AES-128-ECB（PKCS7 补齐）加密后再传 CDN。
function aesEncrypt(key, data) {
  const c = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([c.update(data), c.final()])
}

function aesPaddedSize(n) {
  return Math.ceil((n + 1) / 16) * 16
}

function aesKey(buf) {
  if (buf.length === 16) return buf
  if (buf.length === 32) {
    const s = buf.toString('ascii')
    if (/^[0-9a-fA-F]{32}$/.test(s)) return Buffer.from(s, 'hex')
  }
  return undefined
}

function imageExt(buf) {
  if (!buf || buf.length < 12) return '.jpg'
  if (buf[0] === 0xff && buf[1] === 0xd8) return '.jpg'
  if (buf[0] === 0x89 && buf[1] === 0x50) return '.png'
  if (buf.subarray(0, 4).toString('ascii') === 'GIF8') return '.gif'
  if (buf.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp'
  return '.jpg'
}

function uin() {
  return Buffer.from(String(randomInt(0, 2 ** 32))).toString('base64')
}

function headers(token) {
  const h = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': uin(),
  }
  if (token) h.Authorization = `Bearer ${token}`
  return h
}

async function req(method, endpoint, { token, params, body, timeout = 20000, extra = {} } = {}) {
  const url = new URL(endpoint, BASE)
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url.href, {
    method,
    headers: { ...headers(token), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${endpoint} → ${res.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : {}
}

export class WeixinOC {
  constructor(stateFile, mediaDir) {
    this.stateFile = stateFile
    this.mediaDir = mediaDir || join(dirname(stateFile), 'media')
    this.state = this.load()
    this.syncBuf = this.state.syncBuf || ''
    this.contextTokens = this.state.contextTokens || {}
  }

  // 图片、视频这类媒体：先下 CDN，再用随消息发来的密钥解开。
  async downloadMedia(item) {
    const kind = Number(item?.type || 0)
    const box = kind === 2 ? item.image_item : kind === 5 ? item.video_item : kind === 4 ? item.file_item : kind === 3 ? item.voice_item : undefined
    if (!box) return undefined
    const media = box.media || {}
    const param = String(media.encrypt_query_param || '').trim()
    if (!param) return undefined
    let key
    const hex = String(box.aeskey || '').trim()
    if (/^[0-9a-fA-F]{32}$/.test(hex)) key = Buffer.from(hex, 'hex')
    else {
      const b64 = String(media.aes_key || '').trim()
      if (b64) key = aesKey(Buffer.from(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='), 'base64'))
    }
    const r = await fetch(`${CDN}/download?encrypted_query_param=${encodeURIComponent(param)}`, {
      signal: AbortSignal.timeout(30000),
    })
    if (!r.ok) throw new Error(`下载媒体失败 ${r.status}`)
    let buf = Buffer.from(await r.arrayBuffer())
    if (key) buf = aesDecrypt(key, buf)
    mkdirSync(this.mediaDir, { recursive: true })
    const ext = kind === 2 ? imageExt(buf) : kind === 5 ? '.mp4' : kind === 4 ? '.bin' : '.silk'
    const file = join(this.mediaDir, `${Date.now()}-${randomUUID().slice(0, 8)}${ext}`)
    writeFileSync(file, buf)
    return file
  }

  load() {
    try { return JSON.parse(readFileSync(this.stateFile, 'utf8')) } catch { return {} }
  }

  save() {
    this.state = {
      botToken: this.token,
      baseUrl: this.baseUrl,
      accountId: this.accountId,
      userId: this.userId,
      syncBuf: this.syncBuf,
      contextTokens: this.contextTokens,
      lastPeer: this.state.lastPeer,
      savedAt: new Date().toISOString(),
    }
    mkdirSync(dirname(this.stateFile), { recursive: true })
    writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2))
  }

  get token() { return this.state.botToken || undefined }
  get baseUrl() { return this.token ? BASE : BASE }
  get accountId() { return this.state.accountId }
  get userId() { return this.state.userId }

  get loggedIn() { return !!this.state.botToken }

  // 申请二维码，同时把图存到本地，返回 { qrcode, link, imagePath }
  async requestQr(imagePath) {
    const data = await req('GET', 'ilink/bot/get_bot_qrcode', { params: { bot_type: '3' } })
    const qrcode = String(data.qrcode || '').trim()
    const link = String(data.qrcode_img_content || '').trim()
    if (!qrcode || !link) throw new Error('二维码响应缺字段：' + JSON.stringify(data).slice(0, 200))
    let saved
    try {
      const r = await fetch(QR_API + encodeURIComponent(link), { signal: AbortSignal.timeout(15000) })
      if (r.ok) {
        mkdirSync(dirname(imagePath), { recursive: true })
        writeFileSync(imagePath, Buffer.from(await r.arrayBuffer()))
        saved = imagePath
      }
    } catch (e) {
      saved = undefined
    }
    this.pendingQr = { qrcode, link, imagePath: saved }
    return this.pendingQr
  }

  // 等扫码。返回 { status, qr? } —— status: wait | scanned | confirmed | expired
  async waitQr(timeoutMs = 35000) {
    if (!this.pendingQr) throw new Error('还没有申请二维码')
    const data = await req('GET', 'ilink/bot/get_qrcode_status', {
      params: { qrcode: this.pendingQr.qrcode },
      timeout: timeoutMs,
      extra: { 'iLink-App-ClientVersion': '1' },
    })
    const status = String(data.status || 'wait')
    if (status === 'confirmed') {
      if (!data.bot_token) throw new Error('登录成功但没给 bot_token')
      this.state = {
        ...this.state,
        botToken: String(data.bot_token),
        accountId: data.ilink_bot_id ? String(data.ilink_bot_id) : undefined,
        baseUrl: data.baseurl ? String(data.baseurl) : undefined,
        userId: data.ilink_user_id ? String(data.ilink_user_id) : undefined,
      }
      this.save()
      this.pendingQr = null
    }
    return { status, data }
  }

  // 长轮询收消息。返回消息数组（已清洗）。
  async pollUpdates(timeoutMs = 35000) {
    if (!this.loggedIn) throw new Error('还没登录')
    const data = await req('POST', 'ilink/bot/getupdates', {
      token: this.token,
      body: { base_info: { channel_version: 'astrbot' }, get_updates_buf: this.syncBuf },
      timeout: timeoutMs + 5000,
    })
    if (data.get_updates_buf) {
      this.syncBuf = String(data.get_updates_buf)
      this.save()
    }
    const out = []
    for (const msg of Array.isArray(data.msgs) ? data.msgs : []) {
      if (!msg || typeof msg !== 'object') continue
      const from = String(msg.from_user_id || '').trim()
      if (!from) continue
      const ctx = String(msg.context_token || '').trim()
      if (ctx && this.contextTokens[from] !== ctx) {
        this.contextTokens[from] = ctx
        this.save()
      }
      const items = Array.isArray(msg.item_list) ? msg.item_list : []
      const parts = []
      for (const it of items) {
        const t = Number(it?.type || 0)
        if (t === 1) {
          const s = String(it?.text_item?.text || '').trim()
          if (s) parts.push(s)
        } else if (t === 3) {
          parts.push(String(it?.voice_item?.text || '').trim() || '[语音]')
        } else if (t === 2 || t === 4 || t === 5) {
          const tag = t === 2 ? '图片' : t === 4 ? '文件' : '视频'
          try {
            const path = await this.downloadMedia(it)
            parts.push(path ? `[${tag}] ${path}` : `[${tag}]`)
          } catch (e) {
            parts.push(`[${tag}]`)
          }
        }
      }
      const text = parts.join(' ').trim()
      if (!text) continue
      out.push({
        id: String(msg.message_id || msg.msg_id || randomUUID()),
        from,
        text,
        contextToken: ctx,
        time: msg.create_time_ms || msg.create_time || Date.now(),
      })
    }
    return out
  }

  // 「对方正在输入」。要先拿一张 typing_ticket（拿一次能用一阵子）。
  async getTypingTicket(peer) {
    const ctx = this.contextTokens[peer]
    if (!ctx) return undefined
    const now = Date.now()
    const cached = this.ticketCache?.[peer]
    if (cached && cached.ctx === ctx && now < cached.exp) return cached.ticket
    const data = await req('POST', 'ilink/bot/getconfig', {
      token: this.token,
      body: { ilink_user_id: peer, context_token: ctx, base_info: { channel_version: 'astrbot' } },
    })
    const ticket = String(data.typing_ticket || '').trim()
    if (!ticket) return undefined
    this.ticketCache = this.ticketCache || {}
    this.ticketCache[peer] = { ticket, ctx, exp: now + 55000 }
    return ticket
  }

  async setTyping(peer, on) {
    if (!this.loggedIn) return
    const ticket = await this.getTypingTicket(peer)
    if (!ticket) return
    await req('POST', 'ilink/bot/sendtyping', {
      token: this.token,
      body: {
        ilink_user_id: peer,
        typing_ticket: ticket,
        status: on ? 1 : 2,
        base_info: { channel_version: 'astrbot' },
      },
    })
  }

  // 把本地文件传到微信的 CDN（加密后再传）。
  // 流程：申请上传地址 → AES 加密 → POST 密文 → 从响应头拿下载参数。
  // mediaType：1 图片 / 2 视频 / 3 文件。
  async uploadMedia(filePath, to, mediaType = 1) {
    if (!this.loggedIn) throw new Error('还没登录')
    const plain = readFileSync(filePath)
    const rawsize = plain.length
    const rawfilemd5 = createHash('md5').update(plain).digest('hex')
    const filesize = aesPaddedSize(rawsize)
    const filekey = randomBytes(16).toString('hex')
    const aeskey = randomBytes(16)

    const data = await req('POST', 'ilink/bot/getuploadurl', {
      token: this.token,
      timeout: 25000,
      body: {
        filekey,
        media_type: mediaType,
        to_user_id: to,
        rawsize,
        rawfilemd5,
        filesize,
        no_need_thumb: true,
        aeskey: aeskey.toString('hex'),
        base_info: { channel_version: 'astrbot' },
      },
    })

    const fullUrl = String(data.upload_full_url || '').trim()
    const uploadParam = String(data.upload_param || '').trim()
    let uploadUrl
    if (fullUrl) uploadUrl = fullUrl
    else if (uploadParam) {
      uploadUrl = `${CDN}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`
    } else {
      throw new Error('申请上传地址失败：' + JSON.stringify(data).slice(0, 200))
    }

    const ciphertext = aesEncrypt(aeskey, plain)
    let lastErr
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(uploadUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: new Uint8Array(ciphertext),
          signal: AbortSignal.timeout(60000),
        })
        if (res.status === 200) {
          const downloadParam = res.headers.get('x-encrypted-param')
          if (!downloadParam) throw new Error('CDN 传完了，但没给下载参数')
          return {
            filekey,
            downloadParam,
            aeskeyHex: aeskey.toString('hex'),
            rawSize: rawsize,
            cipherSize: ciphertext.length,
          }
        }
        const errMsg = res.headers.get('x-error-message') || (await res.text()).slice(0, 200)
        lastErr = new Error(`CDN 上传失败 ${res.status}：${errMsg}`)
        if (res.status >= 400 && res.status < 500) throw lastErr
      } catch (e) {
        lastErr = e
        if (/CDN 上传失败 4/.test(e.message)) throw e
      }
      await new Promise((r) => setTimeout(r, 800 * attempt))
    }
    throw lastErr || new Error('CDN 上传失败')
  }

  // 发图片：先把文件传上去，再发一条 image_item 消息指向它。
  // 发一条消息，item_list 里只放一项
  async postItem(to, ctx, item) {
    const data = await req('POST', 'ilink/bot/sendmessage', {
      token: this.token,
      timeout: 25000,
      body: {
        base_info: { channel_version: 'astrbot' },
        msg: {
          from_user_id: '',
          to_user_id: to,
          client_id: randomUUID().replaceAll('-', ''),
          message_type: 2,
          message_state: 2,
          context_token: ctx,
          item_list: [item],
        },
      },
    })
    if (data && data.ret !== undefined && data.ret !== 0) {
      throw new Error('发送失败：' + JSON.stringify(data).slice(0, 200))
    }
    return data
  }

  async sendImage(to, filePath, text) {
    if (!this.loggedIn) throw new Error('还没登录')
    const ctx = this.contextTokens[to]
    if (!ctx) throw new Error('这个人还没发过消息，缺 context_token')
    const up = await this.uploadMedia(filePath, to, 1)
    // 图前面那句话单独发一条，微信那边显示得更自然
    let textRes
    if (text) textRes = await this.postItem(to, ctx, { type: 1, text_item: { text } })
    const imageItem = {
      type: 2,
      image_item: {
        media: {
          encrypt_query_param: up.downloadParam,
          aes_key: Buffer.from(up.aeskeyHex).toString('base64'),
          encrypt_type: 1,
        },
        mid_size: up.cipherSize,
      },
    }
    const data = await this.postItem(to, ctx, imageItem)
    return { ...up, textRes, data }
  }

  // 发语音条（聊天里那条按住说话的）。media_type=4 + voice_item，
  // 2026-11-20 中午试过：接口认这个组合，返回 message_id 不报错。
  // 还差一步——微信的语音条要 SILK 编码，塞 mp3/wav 进去接口收下了，能不能播得等对方那头看。
  async sendVoice(to, filePath, text) {
    if (!this.loggedIn) throw new Error('还没登录')
    const ctx = this.contextTokens[to]
    if (!ctx) throw new Error('这个人还没发过消息，缺 context_token')
    const up = await this.uploadMedia(filePath, to, 4)
    let textRes
    if (text) textRes = await this.postItem(to, ctx, { type: 1, text_item: { text } })
    const voiceItem = {
      type: 3,
      voice_item: {
        media: {
          encrypt_query_param: up.downloadParam,
          aes_key: Buffer.from(up.aeskeyHex).toString('base64'),
          encrypt_type: 1,
        },
        len: String(up.rawSize),
      },
    }
    const data = await this.postItem(to, ctx, voiceItem)
    return { ...up, textRes, data }
  }

  // 发文件（mp3、pdf、zip 之类）：微信那边显示成一个能点开的附件
  async sendFile(to, filePath, text) {
    if (!this.loggedIn) throw new Error('还没登录')
    const ctx = this.contextTokens[to]
    if (!ctx) throw new Error('这个人还没发过消息，缺 context_token')
    const up = await this.uploadMedia(filePath, to, 3)
    let textRes
    if (text) textRes = await this.postItem(to, ctx, { type: 1, text_item: { text } })
    const fileName = String(filePath).split(/[\\/]/).pop()
    const fileItem = {
      type: 4,
      file_item: {
        media: {
          encrypt_query_param: up.downloadParam,
          aes_key: Buffer.from(up.aeskeyHex).toString('base64'),
          encrypt_type: 1,
        },
        file_name: fileName,
        len: String(up.rawSize),
      },
    }
    const data = await this.postItem(to, ctx, fileItem)
    return { ...up, fileName, textRes, data }
  }

  // 给某个人发一条文字。必须有这个人发过来的 context_token。
  async sendText(to, text) {
    if (!this.loggedIn) throw new Error('还没登录')
    const ctx = this.contextTokens[to]
    if (!ctx) throw new Error('这个人还没发过消息，缺 context_token')
    const data = await req('POST', 'ilink/bot/sendmessage', {
      token: this.token,
      body: {
        base_info: { channel_version: 'astrbot' },
        msg: {
          from_user_id: '',
          to_user_id: to,
          client_id: randomUUID().replaceAll('-', ''),
          message_type: 2,
          message_state: 2,
          context_token: ctx,
          item_list: [{ type: 1, text_item: { text } }],
        },
      },
    })
    if (data && data.ret !== undefined && data.ret !== 0) {
      throw new Error('发送失败：' + JSON.stringify(data).slice(0, 200))
    }
    return data
  }
}
