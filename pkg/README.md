# dsh-wx-bridge

把你的**个人微信**接到 [DSH](https://github.com/deepseek-ai/deepseek-harness) 上。
微信里说的话进到家里那条会话；她在家里说的话（连闹钟把她叫起来时嘟囔的那句）抄一份回到微信。

**一条链接装完**：插件和中继都在这一个包里，中继由插件自己拉起来、自己看着。

## 一键安装

```sh
dsh plugin --profile web add https://github.com/yez19297-a11y/dsh-wx-bridge/releases/latest/download/dsh-wx-bridge-latest.tgz
```

桌面版把 `web` 换成 `desktop`。也可以在 DSH 的插件页把上面那条地址贴进去。

装完**重启一次 DSH**。

## 装完要配的

装好之后到 **DSH → 设置 → 插件 → 配置 → dsh-wx-bridge** 里填：

| 设置项 | 默认 | 说明 |
|---|---|---|
| 你和她聊天的会话 | 空 | **必填**。会话 id 里的一段（`session-xxxxxxxx-…` 里那串）。不填，家里说的话不会抄到微信 |
| 中继工作目录 | `~/.dsh/wx-bridge` | 登录态、发不出去的队列、二维码、收到的图都在这儿 |
| 中继地址 | `http://127.0.0.1:18123` | 中继在哪 |
| 中继端口 | `18123` | 只绑 `127.0.0.1` |
| 推送名字 | `她` | 推到微信时带的名字 |
| 保活间隔 | `30000` | 多久探一次中继（毫秒） |
| 启动时自动拉起中继 | 开 | 关掉 = 你自己起 |

这些也都认环境变量（`WX_HOME_SESSION`、`WX_BRIDGE_DIR`、`WX_BRIDGE_URL`、`WX_BRIDGE_PORT`、`WX_NAME`、`WX_KEEPALIVE_MS`），设置页里填的值优先。

「你和她聊天的会话」怎么找：在 DSH 里正常跟她聊两句，看会话 id，取中间那串十六进制。

## 第一次：扫码登录

中继起来之后（插件会自动拉），跟它要一张二维码：

```sh
# 要码：图存到 <WX_BRIDGE_DIR>/qr/qr-<时间>.png
curl -X POST http://127.0.0.1:18123/login

# 问扫上没有：wait / scanned / confirmed / expired（长轮询）
curl "http://127.0.0.1:18123/login/status?wait=20000"
```

手机微信 → 扫一扫 → 右上角「相册」→ 选那张图 → 确认。

**登录完要对方先给你发一句**：发消息要约对方发来的 `context_token`，第一次必须他先开口。

## 它做了什么

1. **中继**（`relay/wx-bridge.mjs`，本包自带）：跟微信官方接口打交道——扫码登录、长轮询收消息、发文字/图/文件。起在 `127.0.0.1:18123`。
2. **插件本体**（`lib/index.js`）：
   - DSH 启动时探一下中继，没在跑就拉起来；之后每 30 秒探一次，挂了重拉。
   - 监听会话事件：主会话每出现一条助手消息，就把文字推到中继 → 微信。中继自己做去重（15 秒内同一句只发一次）。

## 接口

| 方法 | 路径 | 干什么 |
|---|---|---|
| GET | `/health` | 微信登没登、在线没有、家那头通不通 |
| POST | `/push` | 把话/图/文件推到微信：`text`、`image`、`images`、`file`、`name` |
| POST | `/login` | 申请二维码，返回 `qrcode`、`link`、`imagePath` |
| GET | `/login/status?wait=毫秒` | 问扫上没有 |

## 要双向互通还得配 dsh-world

插件这半只负责「家里 → 微信」。要让「微信 → 家里」也通，在 DSH profile 的 `cordis.patch.yml` 里给 dsh-world 挂一个出口：

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

## 许可

MIT，见 `LICENSE`。
