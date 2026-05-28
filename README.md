# douyin-no-watermark

抖音视频分享文案/链接 → **无水印直链 + 流式下载**。纯 Node(全局 `fetch`),不依赖 cookie / Python / 第三方桥。

## 安装

```bash
npm install
npm run build      # 输出到 dist/
```

## 库用法

```ts
import { resolve, fetchFromShare } from 'douyin-no-watermark'

// 仅解析:拿到无水印直链 + 元信息
const meta = await resolve('8.94 复制打开抖音...')
// → { awemeId, author, title, noWatermarkUrl }

// 解析 + 流式下载到本地
const r = await fetchFromShare('8.94 复制打开抖音...', './out')
// → { meta, localPath, bytes, sha256 }
```

直链 `meta.noWatermarkUrl` 有时效,**不要长期缓存**;要持久化请下载落地。

## CLI

```bash
# 只解析,打印 meta
npm run cli -- "8.94 复制打开抖音 ..."

# 解析 + 下载到 ./out
npm run cli -- "8.94 复制打开抖音 ..." ./out
```

## Chrome 扩展

`extension/` 是一个独立的 Chrome MV3 扩展,提供 GUI 用法(粘贴 → 解析 → 浏览器原生下载弹窗)。

加载方式:

1. 打开 `chrome://extensions`,右上角开「开发者模式」
2. 点「加载已解压的扩展程序」,选择本仓库的 `extension/` 目录
3. 点工具栏图标 → 弹出 popup → 粘贴分享文案 → 解析 → 下载

实现要点:
- 解析逻辑(`extension/popup.js`)是浏览器版重写,**不复用**根目录的 Node 库(`node:fs/stream` 用不上;下载交给 `chrome.downloads`)。两边思路一致。
- 移动 UA + Referer 通过 `declarativeNetRequest` 动态规则注入,`initiatorDomains: [chrome.runtime.id]` 限定**仅对扩展自己发的请求生效**,不影响用户正常浏览。
- 下载用 `chrome.downloads.download({ saveAs: true })`,Chrome 原生保存对话框,用户自选位置。

## 工作原理

1. 从分享文案抠出链接(短链/直链皆可),跟随重定向 → 19 位 `aweme_id`。
2. 请求 `https://www.iesdouyin.com/share/video/<aweme_id>/`(移动 UA),从内嵌脚本截出 `window._ROUTER_DATA`(花括号配对、跳过字符串内的括号)。
3. 取 `item.video.play_addr.url_list[0]`,把 `/aweme/v1/playwm/` 替换为 `/aweme/v1/play/`,即无水印直链。
4. 下载走流式 + 超时 + `Range` 断点续传(单条可达上百 MB,禁一次性入内存);完成后流式 sha256。

## 已知边界

- **匿名路径仅单档 ≤720p**(`bit_rate` 为空),更高画质需登录态(cookie)路径。
- 仅实现「移动 UA + iesdouyin 分享页」一条路。被风控/页面改版(`_ROUTER_DATA` 缺失)时:
  - `resolve()` 抛错并提示「疑似风控/改版」,此时在调用层兜底(等待/换 UA/登录态),**库内不预先抽象 strategy 框架**。
- 图集、直播、已失效视频 → `item_list` 为空,抛错。
- 验收(真 9:16 / 时长 / 几何)由调用方完成,库不做深度校验,只做 `bytes >= 10KB` 兜底。

## 类型

```ts
interface DouyinVideoMeta {
  awemeId: string
  author: string
  title: string
  noWatermarkUrl: string   // playwm→play,有时效
}

interface FetchVideoResult {
  meta: DouyinVideoMeta
  localPath: string
  bytes: number
  sha256: string          // 文件内容 sha256(流式算)
}
```

## 依赖

零运行时依赖,仅 Node 标准库。要求 Node ≥ 20(全局 `fetch`、`stream/web`)。
