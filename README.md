# dsh-wx-bridge

把**个人微信**接到 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）上：
你在微信里说的话进到家里那条会话，她在家里说的话（包括闹钟把她叫起来时嘟囔的那句）
抄一份回到微信。图、文件、语音条也能双向走。

用一个没用过的微信号扫码登录，走的是微信官方的 `openclaw-weixin` 接口，纯 HTTP：
不需要 OpenClaw、不需要 docker、不需要公网 IP，一台能上网的小机器就够。

最早是给一个叫「溯」的数字生命写的，2026 年 11 月 11 日深夜跑通了第一条。

## 一键安装

```sh
dsh plugin --profile web add https://github.com/yez19297-a11y/dsh-wx-bridge/releases/latest/download/dsh-wx-bridge-latest.tgz
```

桌面版把 `web` 换成 `desktop`；也可以在 DSH 的插件页把上面那条地址直接贴进去。

装完**重启一次 DSH**，然后到 **设置 → 插件 → 配置 → dsh-wx-bridge** 里填两样：
**你和她聊天的会话**（会话 id 里的一段）和 **中继工作目录**（留空也行）。
中继就在这个包里，插件会自己把它拉起来、自己看着。

第一次还要扫码登录一次，见下面「扫码登录」。

> 只想读源码、自己起中继的，跳到「它由三块组成」后面的说明。

## 它由三块组成

| 块 | 文件 | 干什么 |
|---|---|---|
| 中继 | `src/wx-bridge.mjs`、`src/weixin-oc.mjs` | 一个本机 HTTP 服务（默认 `127.0.0.1:18123`）：收微信消息、送进家；把家里的话推回微信 |
| 镜像插件 | `plugin/wx-mirror.mjs` | 一个 DSH 插件：家里每说一句就抄一份给中继；DSH 一启动顺手把中继带起来 |
| 看门狗 | `src/watchdog.mjs` | 每 30 秒看一眼中继，卡死或者被系统收掉就杀掉重拉 |

## 装

前提：Node 18 以上；已经装好 DSH，并且有一台一直开着的机器。

```sh
git clone <这个仓库>
cd dsh-wechat-bridge
npm install        # 这个仓库没有第三方依赖，这一步只是建出 node_modules
```

### 1. 起中继

```sh
WX_BRIDGE_DIR="$HOME/.dsh/worlds/default/room/wx-bridge" \
  setsid nohup node src/wx-bridge.mjs > "$HOME/.dsh/worlds/default/room/wx-bridge/bridge.log" 2>&1 &
```

第一次跑之前先建目录：

```sh
mkdir -p ~/.dsh/worlds/default/room/wx-bridge
```

### 2. 扫码登录

```sh
# 要一张二维码，图会存到 <WX_BRIDGE_DIR>/qr/qr-<时间>.png
curl -X POST http://127.0.0.1:18123/login

# 问扫上没有（长轮询）
curl "http://127.0.0.1:18123/login/status?wait=20000"
```

手机微信 → 扫一扫 → 右上角「相册」→ 选那张图 → 确认。

二维码五分钟有效。

**登录完要对方先给你发一句话**：发消息要对方发来的 `context_token`，第一次必须他先开口。

### 3. 把插件挂进 DSH

把 `plugin/wx-mirror.mjs` 放到机器上任意位置，然后在 DSH profile 的
`cordis.patch.yml` 里 append 一段（见 `plugin/cordis.patch.snippet.yml`）：

```yaml
- insert:
    - id: wx-mirror
      name: /absolute/path/to/wx-mirror.mjs
```

再在同一个文件里把 dsh-world 的出口指向中继（这样她的回复才会推到微信）：

```yaml
- id: dsh-world
  name: dsh-world
  config:
    bridge: true
    outlets:
      - name: 微信桥
        url: http://127.0.0.1:18123/push
        kinds: [reply, busy, reach]
```

改完重启 DSH。

### 4. 看门狗（可选，但强烈建议）

```sh
setsid nohup node src/watchdog.mjs > <WX_BRIDGE_DIR>/watchdog.log 2>&1 &
```

或者干脆交给 systemd，`Restart=always` 比看门狗省心。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `WORLD_DIR` | `/root/.dsh/worlds/default` | 世界目录，中继在它下面找 `room/wx-bridge` |
| `WX_BRIDGE_DIR` | `/root/.dsh/worlds/default/room/wx-bridge` | 中继的工作目录（登录态、队列、二维码、收到的图都在这儿） |
| `WX_BRIDGE_PORT` | `18123` | 中继监听的端口（只绑 `127.0.0.1`） |
| `WX_BRIDGE_URL` | `http://127.0.0.1:18123` | 插件去哪找中继 |
| `WX_HOME_SESSION` | — | **你和她聊天那条会话 id 里的一段**（`session-xxxxxxxx-…` 里那串）。不填就镜像不到 |
| `WX_WATCHDOG` | `<WX_BRIDGE_DIR>/watchdog.mjs` | 插件启动时拉谁起来 |
| `WX_DEBUG_LOG` | `<WX_BRIDGE_DIR>/mirror-debug.log` | 镜像插件的调试日志 |
| `WX_MEME_DIR` | 空 | `tools/发图.mjs --meme` 去哪个目录挑表情包 |
| `DSH_HOME` | `/root/.dsh` | 用来读 `.credentials.yaml` 签浏览器 cookie |

## 接口

| 方法 | 路径 | 干什么 |
|---|---|---|
| GET | `/health` | 家那头通不通、微信登没登、在线没有 |
| POST | `/in` | （DSH 内部用）把微信收到的消息送进家 |
| POST | `/push` | 把话/图/文件推到微信。收 `text`、`image`、`images`、`file`、`name` |
| POST | `/login` | 申请二维码，返回 `qrcode`、`link`、`imagePath` |
| GET | `/login/status?wait=毫秒` | 问扫上没有：`wait` / `scanned` / `confirmed` / `expired` |

## 目录里会有什么

```
wx-bridge/
  wx-state.json       登录态（bot_token、游标、每个人的 context_token）—— 别外传，别提交
  qr/                 每次申请的二维码图
  media/              微信发来的图、视频，下载解密后存这儿
  outbox.jsonl        没发出去的话，排队等着
  bridge.log          中继的账
```

`.gitignore` 里已经把这些排除了。

## 踩过的坑（都写在这儿了，少走一遍）

- **会话 id 要用「包含」匹配，不能用「前缀」**。真实 id 长这样
  `session-53d9ddc6-4f7d-4cb7-9fab-1784cdea01c3`，前面挂着 `session-`，后面还有尾号。
  一开始写 `startsWith('53d9ddc6')`，结果一句都没命中，家里说的话从来没到过微信。
- **同一条话会推两遍**：dsh-world 的 outlets 会把 markdown 剥掉，镜像插件推的是原文，
  拿原文硬比永远对不上。比较前先规范化（去掉 `` ` `` `*` `_` `~` `#` `>` 再压空白）。
- **微信的「主动发消息」要约对方的 `context_token`**，所以第一次必须对方先开口。
- **发图**：`getuploadurl` 申请 → AES-128-ECB(PKCS7) 加密 → 密文 POST 到 CDN →
  发 `image_item`，`aes_key` 填 base64(hex 字符串)，`mid_size` 填密文长度。
  想自己下回来验一遍是不行的（CDN 会拒掉自己传的图），成没成只能看对方那头。
- **发文件**：同一条上传管线，`media_type=3`，发出去的 item 是 `file_item`。
- **语音条**：`media_type=4` + `voice_item` 能通，但微信的语音是 SILK 格式，
  塞 wav 进去接口收得下、那头不一定播。要真做对得装 SILK 编码器（pilk / silk-v3）。
- 浏览器 cookie 的签名密钥在 `$DSH_HOME/.credentials.yaml` 里，
  找 `client-connection/browser-session` 那段的 `secret`。

## License

MIT，见 `LICENSE`。
