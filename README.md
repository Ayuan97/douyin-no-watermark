# douyin-no-watermark

抖音视频分享文案/链接 → **无水印直链 + 流式下载**。纯 Node(全局 `fetch`)为主路径,不依赖 cookie / Python;可选无头浏览器兜底。

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
// → { awemeId, author, title, noWatermarkUrl, resolvedVia }

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

## 验证(样例)

默认样例短链:`https://v.douyin.com/1KyuRCvMRN0/`(aweme_id `7081608169876753702`)

```bash
# 单元测试(默认跳过网络)
npm test

# 打开网络样例测试
DOUYIN_NETWORK_TEST=1 npm test

# 构建后跑可复现验证脚本(解析 + 抽检无水印 URL 的 HTTP/类型/大小)
npm run verify:sample

# 分享页必须 JS 渲染时,可选启用无头浏览器兜底(需本机 Chrome + puppeteer-core)
npm i -D puppeteer-core
DOUYIN_USE_BROWSER=1 npm run verify:sample
```

## Chrome 扩展

`extension/` 是一个独立的 Chrome MV3 扩展,提供 GUI 用法(粘贴 → 解析 → 浏览器原生下载弹窗)。

加载方式:

1. 打开 `chrome://extensions`,右上角开「开发者模式」
2. 点「加载已解压的扩展程序」,选择本仓库的 `extension/` 目录
3. 点工具栏图标 → 弹出 popup → 粘贴分享文案 → 解析 → 下载

实现要点:
- 解析逻辑(`extension/popup.js`)是浏览器版重写,**不复用**根目录的 Node 库(`node:fs/stream` 用不上;下载交给 `chrome.downloads`)。两边思路一致,同样有 item_list → HTML 回退。
- 移动 UA + Referer 通过 `declarativeNetRequest` 动态规则注入,`initiatorDomains: [chrome.runtime.id]` 限定**仅对扩展自己发的请求生效**,不影响用户正常浏览。
- 下载用 `chrome.downloads.download({ saveAs: true })`,Chrome 原生保存对话框,用户自选位置。

## 工作原理

1. 从分享文案抠出链接(短链/直链皆可),跟随重定向 → 19 位 `aweme_id`。
2. **路径 1(优先)**:请求 `https://www.iesdouyin.com/share/video/<aweme_id>/`(移动 UA),从内嵌 `window._ROUTER_DATA` 取 `videoInfoRes.item_list[0].video.play_addr`。
3. **路径 2(回退)**:若 `item_list` 为空(2026 起常见:页面只剩 A/B 配置),改拉 `https://m.douyin.com/share/video/<aweme_id>`(及 iesdouyin 同页),从 HTML 的 `<video src>` / `playwm` URL / `video_id=` 提取播放信息。
4. 把 `/aweme/v1/playwm/` 换成 `/aweme/v1/play/`,或用 `video_id` 拼 `https://www.iesdouyin.com/aweme/v1/play/?video_id=...`,得到无水印直链。
5. **路径 3(可选)**:环境变量 `DOUYIN_USE_BROWSER=1` 时,用 `puppeteer-core` + 本机 Chrome 打开移动分享页,等 `<video>` 渲染后再取 src(默认不启用,保持零运行时依赖)。
6. 下载走流式 + 超时 + `Range` 断点续传;完成后流式 sha256。

失败时错误信息会标明卡在哪一步(`router_item_list` / `share_html` / `browser_video`)。

## 已知边界

- **匿名路径仅单档 ≤720p**(`bit_rate` 为空),更高画质需登录态(cookie)路径。
- 海外/机房出口 IP 常被抖音直接返回「抱歉出错了,请尝试在抖音内观看」——这与解析代码无关,需可访问抖音的网络重试。
- `iteminfo` 等旧公开 API 现多返回 `encrypt_data_miss`,本库不再依赖。
- 图集、直播、已失效视频仍会解析失败。
- 验收(真 9:16 / 时长 / 几何)由调用方完成,库不做深度校验,只做 `bytes >= 10KB` 兜底。

## 类型

```ts
interface DouyinVideoMeta {
  awemeId: string
  author: string
  title: string
  noWatermarkUrl: string   // playwm→play,有时效
  resolvedVia?: 'router_item_list' | 'share_html' | 'browser_video'
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

可选:`puppeteer-core`(仅 `DOUYIN_USE_BROWSER=1` 时需要)。
