#!/usr/bin/env node
// 往微信发一张图。
//
//   node 发图.mjs <图片路径> [一句话]
//   node 发图.mjs --meme maozhua [一句话]     # 从表情包里挑一张
//
// 图先传到微信 CDN（AES 加密），再发一条 image_item 指过去。
// 走的还是桥的 /push，所以和别的话一样会记在 bridge.log 里。

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const PORT = Number(process.env.WX_BRIDGE_PORT || 18123)
const PACK = process.env.WX_MEME_DIR || ''

function findMeme(name) {
  if (!existsSync(PACK)) throw new Error('表情包目录不在：' + PACK)
  const hits = []
  for (const dir of readdirSync(PACK)) {
    const p = join(PACK, dir)
    if (!statSync(p).isDirectory()) continue
    for (const f of readdirSync(p)) {
      if (f.replace(/\.[^.]+$/, '') === name) hits.push(join(p, f))
    }
  }
  if (!hits.length) throw new Error(`表情包里没有「${name}」，有的：` + listMemes().join(' '))
  return hits[0]
}

function listMemes() {
  const out = []
  for (const dir of readdirSync(PACK)) {
    const p = join(PACK, dir)
    if (!statSync(p).isDirectory()) continue
    for (const f of readdirSync(p)) out.push(f.replace(/\.[^.]+$/, ''))
  }
  return out
}

let args = process.argv.slice(2)
if (args[0] === '--list') {
  console.log(listMemes().join(' '))
  process.exit(0)
}
let file
if (args[0] === '--meme') {
  args = args.slice(1)
  file = findMeme(args.shift())
} else {
  file = args.shift()
}
if (!file) {
  console.error('用法：node 发图.mjs <图片路径|--meme 名字> [一句话]')
  process.exit(1)
}
if (!existsSync(file)) throw new Error('图不在：' + file)
const text = args.join(' ').trim()

const res = await fetch(`http://127.0.0.1:${PORT}/push`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ image: file, ...(text ? { text } : {}) }),
})
console.log(await res.text())
