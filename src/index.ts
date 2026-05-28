// 抖音无水印源视频获取:短链/分享文案 → aweme_id → iesdouyin 分享页内嵌
// window._ROUTER_DATA → play_addr,playwm→play 去水印 → 流式下载到本地。
// 纯 Node(全局 fetch),不依赖 cookie / Python / 第三方桥。
//
// 已知边界(2026-05 实测):匿名路径仅单档 ≤720p(bit_rate 为空),更高画质需登录态;
// 现仅实现「移动 UA + iesdouyin 分享页」一条路。若被风控/改版(_ROUTER_DATA 缺失),
// 在 resolve() 的错误分支扩展登录态/签名(a_bogus)兜底,勿在此过早抽象成 strategy 框架。
import { createWriteStream, createReadStream, mkdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { pipeline } from 'node:stream/promises'
import { join } from 'node:path'

// ---- 类型 ----------------------------------------------------------------

export interface DouyinVideoMeta {
  awemeId: string
  author: string
  title: string
  /** playwm→play 后的无水印 CDN 直链(有时效,勿长期缓存)。 */
  noWatermarkUrl: string
}

export interface FetchVideoResult {
  meta: DouyinVideoMeta
  localPath: string
  bytes: number
  /** 文件内容 sha256(下载完成后流式算)。 */
  sha256: string
}

// ---- 常量 ----------------------------------------------------------------

const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'

// _ROUTER_DATA 里本模块需要的最小形状。
interface RouterItem {
  aweme_id?: string
  desc?: string
  author?: { nickname?: string }
  video?: { play_addr?: { url_list?: string[] } }
}
interface RouterData {
  loaderData?: { 'video_(id)/page'?: { videoInfoRes?: { item_list?: RouterItem[] } } }
}

// ---- 解析 ----------------------------------------------------------------

// 从分享文案抠出链接,跟随重定向取 19 位 aweme_id。
async function resolveAwemeId(input: string): Promise<string> {
  const m = input.match(/https?:\/\/[^\s]+/)
  if (!m) throw new Error('未找到链接(输入需包含 http(s) 链接)')
  let url = m[0]
  for (let i = 0; i < 6; i++) {
    const idm = url.match(/\/(?:share\/)?video\/(\d+)/)
    if (idm) return idm[1]
    const r = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': UA_MOBILE } })
    const loc = r.headers.get('location')
    if (!loc) break
    url = loc.startsWith('http') ? loc : new URL(loc, url).href
  }
  const idm = url.match(/(\d{15,})/)
  if (idm) return idm[1]
  throw new Error(`无法解析 aweme_id,最终落点:${url}`)
}

// 截取 window._ROUTER_DATA = {...} 这段 JSON(按花括号配对,跳过字符串内的括号)。
function extractRouterData(html: string): RouterData {
  let i = html.indexOf('window._ROUTER_DATA')
  if (i < 0) throw new Error('分享页无 _ROUTER_DATA(疑似被风控/改版,需登录态兜底)')
  i = html.indexOf('{', i)
  let depth = 0
  let inStr = false
  let esc = false
  let j = i
  for (; j < html.length; j++) {
    const ch = html[j]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
    } else if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) {
      j++
      break
    }
  }
  return JSON.parse(html.slice(i, j)) as RouterData
}

/**
 * 解析(不下载):分享文案/链接 → 无水印直链 + 元信息。
 *
 * @example
 *   const meta = await resolve('8.94 复制打开抖音...')
 *   console.log(meta.noWatermarkUrl)
 */
export async function resolve(input: string): Promise<DouyinVideoMeta> {
  const awemeId = await resolveAwemeId(input)
  const r = await fetch(`https://www.iesdouyin.com/share/video/${awemeId}/`, {
    headers: { 'User-Agent': UA_MOBILE }
  })
  const item = extractRouterData(await r.text()).loaderData?.['video_(id)/page']?.videoInfoRes
    ?.item_list?.[0]
  if (!item) throw new Error('item_list 为空(图集/直播/已失效?)')
  const wm = item.video?.play_addr?.url_list?.[0]
  if (!wm) throw new Error('play_addr 为空,无可下载直链')
  return {
    awemeId: item.aweme_id ?? awemeId,
    author: item.author?.nickname ?? '',
    title: item.desc ?? '',
    noWatermarkUrl: wm.replace('/aweme/v1/playwm/', '/aweme/v1/play/')
  }
}

// ---- 下载 ----------------------------------------------------------------

function safeSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

// 流式下载 + 超时 + Range 断点续传(抖音单条可达上百 MB,禁一次性入内存)。
async function downloadTo(
  url: string,
  outPath: string,
  { timeoutMs = 600_000, retries = 4 } = {}
): Promise<number> {
  let from = 0
  let total = 0
  for (let attempt = 1; attempt <= retries; attempt++) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const headers: Record<string, string> = {
        'User-Agent': UA_MOBILE,
        Referer: 'https://www.douyin.com/'
      }
      if (from > 0) headers.Range = `bytes=${from}-`
      const r = await fetch(url, { headers, signal: ac.signal })
      if (r.status !== 200 && r.status !== 206) throw new Error(`下载 HTTP ${r.status}`)
      if (!r.body) throw new Error('下载响应无 body')
      if (from === 0 && (r.headers.get('content-type') ?? '').includes('text/html')) {
        throw new Error('期望视频却得到 HTML(疑似风控/验证页)')
      }
      const cr = r.headers.get('content-range')
      total = cr ? Number(cr.split('/')[1]) : Number(r.headers.get('content-length') ?? 0) + from
      const ws = createWriteStream(outPath, { flags: from > 0 ? 'a' : 'w' })
      // r.body 为 DOM 版 ReadableStream,与 node:stream/web 类型分歧,显式转换。
      await pipeline(Readable.fromWeb(r.body as unknown as WebReadableStream), ws)
      const bytes = safeSize(outPath)
      if (total && bytes < total) throw new Error(`未下完 ${bytes}/${total}`)
      return bytes
    } catch (e) {
      from = safeSize(outPath) // 已落部分,下一轮 Range 续传
      if (attempt === retries) throw new Error(`下载失败(${String(e)}),已落 ${from}/${total} 字节`)
    } finally {
      clearTimeout(timer)
    }
  }
  return safeSize(outPath)
}

// 流式算 sha256(下载完成后对最终文件,避免续传破坏增量哈希)。
async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

const safeName = (s: string): string =>
  s.replace(/[\\/:*?"<>|\n\r\t#]/g, '_').slice(0, 60).trim()

/**
 * 解析 + 下载 + 轻校验 + sha256。深度媒体验收(真 9:16/时长/几何)请自行做。
 *
 * @example
 *   const r = await fetchFromShare('8.94 复制打开抖音...', './out')
 *   console.log(r.localPath, r.bytes, r.sha256)
 */
export async function fetchFromShare(input: string, outDir: string): Promise<FetchVideoResult> {
  const meta = await resolve(input)
  mkdirSync(outDir, { recursive: true })
  const localPath = join(outDir, `${safeName(meta.author)}_${safeName(meta.title)}.mp4`)
  const bytes = await downloadTo(meta.noWatermarkUrl, localPath)
  if (bytes < 10 * 1024) throw new Error(`文件过小(${bytes} 字节),疑似下载失败`)
  const sha256 = await sha256File(localPath)
  return { meta, localPath, bytes, sha256 }
}
