#!/usr/bin/env node
// 自测：把一张图传上微信 CDN，再自己下载回来解开，比对 md5。
// 两边一样就说明「传上去的东西，微信那头真的解得开」——不用等人看图才知道成没成。
//
//   node 测发图.mjs [图片路径]

import { readFileSync } from 'node:fs'
import { createHash, createDecipheriv } from 'node:crypto'
import { WeixinOC } from './weixin-oc.mjs'

const DIR = process.env.WX_BRIDGE_DIR || '/root/.dsh/worlds/default/room/wx-bridge'
const CDN = 'https://novac2c.cdn.weixin.qq.com/c2c'
const file = process.argv[2]

const wx = new WeixinOC(`${DIR}/wx-state.json`, `${DIR}/media`)
if (!wx.loggedIn) throw new Error('没登录')
const peer = wx.state.lastPeer || Object.keys(wx.contextTokens)[0]
if (!peer) throw new Error('还没有人给机器人发过消息')

const plain = readFileSync(file)
const md5 = (b) => createHash('md5').update(b).digest('hex')

console.log('本地 :', file, plain.length, 'bytes', md5(plain))

const up = await wx.uploadMedia(file, peer, 1)
console.log('上传 :', 'filekey', up.filekey, '密文', up.cipherSize, 'bytes')

const url = `${CDN}/download?encrypted_query_param=${encodeURIComponent(up.downloadParam)}`
const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
if (!res.ok) throw new Error(`下载失败 ${res.status} ${(await res.text()).slice(0, 200)}`)
const cipher = Buffer.from(await res.arrayBuffer())
const d = createDecipheriv('aes-128-ecb', Buffer.from(up.aeskeyHex, 'hex'), null)
const back = Buffer.concat([d.update(cipher), d.final()])

console.log('下载 :', '密文', cipher.length, 'bytes → 解开', back.length, 'bytes')
const same = md5(back) === md5(plain)
console.log(same ? '✅ 一模一样，微信那头解得开' : '❌ 对不上：下载回来的不是原图')
process.exit(same ? 0 : 1)
