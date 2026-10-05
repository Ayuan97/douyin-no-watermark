// 抖音无水印源视频获取:短链/分享文案 → aweme_id → 分享页解析 → playwm→play 去水印 → 流式下载。
// 纯 Node(全局 fetch)为主路径;可选 DOUYIN_USE_BROWSER=1 启用无头浏览器兜底(需自行安装 puppeteer-core)。
//
// 解析顺序(任一成功即返回):
//   1) iesdouyin 分享页 window._ROUTER_DATA → videoInfoRes.item_list (旧路径,改版后常空)
//   2) m.douyin / iesdouyin 分享页 HTML:<video src> / playwm / video_id= 正则
//   3) (可选) 无头浏览器打开 m.douyin 分享页,等 <video> 渲染后再取 src
//
// 已知边界:匿名路径仅单档 ≤720p;海外/机房 IP 可能直接「抱歉出错了」,与解析逻辑无关。
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
  /** 实际命中的解析路径,便于排障。 */
  resolvedVia?: 'router_item_list' | 'share_html' | 'browser_video'
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
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'

const SHARE_HEADERS: Record<string, string> = {
  'User-Agent': UA_MOBILE,
  Referer: 'https://www.douyin.com/',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
}

// _ROUTER_DATA 里本模块需要的最小形状。
interface RouterItem {
  aweme_id?: string
  desc?: string
  author?: { nickname?: string }
  video?: {
    play_addr?: { url_list?: string[]; uri?: string }
    cover?: { url_list?: string[] }
  }
}
interface RouterData {
  loaderData?: { 'video_(id)/page'?: { videoInfoRes?: { item_list?: RouterItem[] } } }
}

// ---- 工具 ----------------------------------------------------------------

/** playwm → play;或由 video_id/uri 拼 iesdouyin 无水印直链。 */
export function toNoWatermarkUrl(wmOrId: string): string {
  const s = wmOrId.trim()
  if (!s) throw new Error('空的播放地址/video_id')
  if (/^https?:\/\//i.test(s)) {
    return s
      .replace('/aweme/v1/playwm/', '/aweme/v1/play/')
      .replace('/playwm/', '/play/')
  }
  // 裸 video_id / uri
  const id = s.replace(/^video_id=/i, '')
  return `https://www.iesdouyin.com/aweme/v1/play/?video_id=${encodeURIComponent(id)}&ratio=720p&line=0`
}

function extractBalancedJson(html: string, marker: string): unknown {
  let i = html.indexOf(marker)
  if (i < 0) throw new Error(`分享页无 ${marker}`)
  i = html.indexOf('{', i)
  if (i < 0) throw new Error(`${marker} 后无 JSON 对象`)
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
  return JSON.parse(html.slice(i, j))
}

function extractRouterData(html: string): RouterData {
  return extractBalancedJson(html, 'window._ROUTER_DATA') as RouterData
}

function metaFromItem(item: RouterItem, awemeId: string, via: DouyinVideoMeta['resolvedVia']): DouyinVideoMeta {
  const wm = item.video?.play_addr?.url_list?.[0] || item.video?.play_addr?.uri
  if (!wm) throw new Error('play_addr 为空,无可下载直链')
  return {
    awemeId: item.aweme_id ?? awemeId,
    author: item.author?.nickname ?? '',
    title: item.desc ?? '',
    noWatermarkUrl: toNoWatermarkUrl(wm),
    resolvedVia: via
  }
}

function looksLikeBlockedSharePage(html: string): boolean {
  return /special-case-title|抱歉出错了|请尝试在抖音内观看/.test(html)
}

/** 从分享页 HTML 抠 playwm / <video src> / video_id=。 */
function extractPlayCandidateFromHtml(html: string): { urlOrId: string; author: string; title: string } | null {
  // <video ... src="...">
  const videoSrc = html.match(/<video[^>]+src=["']([^"']+)["']/i)?.[1]
  if (videoSrc && /play|aweme|video/i.test(videoSrc)) {
    return { urlOrId: videoSrc, author: '', title: '' }
  }
  // 任意 playwm / aweme/v1/play 绝对地址
  const playUrl = html.match(/https?:\/\/[^"'\\\s<>]+\/aweme\/v1\/playwm\/[^"'\\\s<>]*/)?.[0]
    || html.match(/https?:\/\/[^"'\\\s<>]+\/aweme\/v1\/play\/\?[^"'\\\s<>]*/)?.[0]
  if (playUrl) return { urlOrId: playUrl, author: '', title: '' }

  const vid = html.match(/video_id=([a-zA-Z0-9]+)/)?.[1]
  if (vid) return { urlOrId: vid, author: '', title: '' }

  // 偶发:JSON 片段里的 play_addr.url_list
  const list0 = html.match(/"url_list"\s*:\s*\[\s*"(https?:[^"]+play[^"]+)"/)?.[1]
  if (list0) return { urlOrId: list0.replace(/\\u002F/g, '/').replace(/\\\//g, '/'), author: '', title: '' }

  // 标题/作者尽力从 meta 取
  const title =
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)?.[1]
    || html.match(/<title[^>]*>([^<]+)/i)?.[1]?.replace(/\s*-?\s*抖音\s*$/, '').trim()
    || ''
  void title
  return null
}

async function fetchShareHtml(url: string): Promise<string> {
  const r = await fetch(url, { headers: SHARE_HEADERS, redirect: 'follow' })
  if (!r.ok) throw new Error(`分享页 HTTP ${r.status}: ${url}`)
  return await r.text()
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

async function tryRouterItemList(awemeId: string): Promise<DouyinVideoMeta> {
  const html = await fetchShareHtml(`https://www.iesdouyin.com/share/video/${awemeId}/`)
  if (looksLikeBlockedSharePage(html)) {
    throw new Error('iesdouyin 分享页被风控/地区限制(抱歉出错了)')
  }
  let data: RouterData
  try {
    data = extractRouterData(html)
  } catch (e) {
    throw new Error(`_ROUTER_DATA 提取失败: ${e instanceof Error ? e.message : e}`)
  }
  const item = data.loaderData?.['video_(id)/page']?.videoInfoRes?.item_list?.[0]
  if (!item) throw new Error('item_list 为空(页面改版仅剩 A/B 配置,或图集/直播/已失效)')
  return metaFromItem(item, awemeId, 'router_item_list')
}

async function tryShareHtml(awemeId: string): Promise<DouyinVideoMeta> {
  const urls = [
    `https://m.douyin.com/share/video/${awemeId}`,
    `https://www.iesdouyin.com/share/video/${awemeId}/`
  ]
  const errors: string[] = []
  for (const url of urls) {
    try {
      const html = await fetchShareHtml(url)
      if (looksLikeBlockedSharePage(html)) {
        errors.push(`${url}: 风控/地区限制`)
        continue
      }
      // 若 HTML 里碰巧又有完整 item_list,直接复用
      if (html.includes('item_list') && html.includes('play_addr')) {
        try {
          const data = extractRouterData(html)
          const item = data.loaderData?.['video_(id)/page']?.videoInfoRes?.item_list?.[0]
          if (item?.video?.play_addr) return metaFromItem(item, awemeId, 'share_html')
        } catch {
          /* fall through to regex */
        }
      }
      const cand = extractPlayCandidateFromHtml(html)
      if (!cand) {
        errors.push(`${url}: HTML 无 <video src>/playwm/video_id`)
        continue
      }
      const title =
        html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)?.[1]
        || html.match(/<title[^>]*>([^<]+)/i)?.[1]?.replace(/\s*-?\s*抖音\s*$/, '').trim()
        || ''
      return {
        awemeId,
        author: cand.author,
        title: cand.title || title,
        noWatermarkUrl: toNoWatermarkUrl(cand.urlOrId),
        resolvedVia: 'share_html'
      }
    } catch (e) {
      errors.push(`${url}: ${e instanceof Error ? e.message : e}`)
    }
  }
  throw new Error(`share_html 失败: ${errors.join(' | ')}`)
}

async function tryBrowserVideo(awemeId: string): Promise<DouyinVideoMeta> {
  // 动态加载,避免变成硬依赖。调用方需: npm i -D puppeteer-core,并提供本机 Chrome。
  // puppeteer-core 为 optional peer,这里用非字面量 import 避开强制类型解析。
  const modName = 'puppeteer-core'
  let puppeteer: { launch: (opts: Record<string, unknown>) => Promise<any> }
  try {
    puppeteer = (await import(modName)) as typeof puppeteer
  } catch {
    throw new Error('未安装 puppeteer-core(DOUYIN_USE_BROWSER=1 时需要: npm i -D puppeteer-core)')
  }
  const executablePath =
    process.env.DOUYIN_CHROME_PATH
    || process.env.CHROME_PATH
    || '/usr/bin/google-chrome-stable'
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--lang=zh-CN']
  })
  try {
    const page = await browser.newPage()
    await page.setUserAgent(UA_MOBILE)
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
    const url = `https://m.douyin.com/share/video/${awemeId}`
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45_000 })
    await page.waitForSelector('video', { timeout: 20_000 }).catch(() => null)
    const info = (await page.evaluate(() => {
      const v = document.querySelector('video') as HTMLVideoElement | null
      const src = (v && (v.currentSrc || v.src)) || ''
      const html = document.documentElement.innerHTML
      const playwm = html.match(/https?:[^"'\\\s]+playwm[^"'\\\s]*/)?.[0] || ''
      const vid = html.match(/video_id=([a-zA-Z0-9]+)/)?.[1] || ''
      const blocked = /special-case-title|抱歉出错了|请尝试在抖音内观看/.test(html)
      const title = document.title || ''
      return { src, playwm, vid, blocked, title, text: (document.body?.innerText || '').slice(0, 200) }
    })) as {
      src: string
      playwm: string
      vid: string
      blocked: boolean
      title: string
      text: string
    }
    if (info.blocked) {
      throw new Error(`浏览器分享页被风控/地区限制: ${info.text.replace(/\s+/g, ' ')}`)
    }
    const urlOrId = info.src || info.playwm || info.vid
    if (!urlOrId) throw new Error('浏览器页无 video src / playwm / video_id')
    return {
      awemeId,
      author: '',
      title: info.title.replace(/\s*-?\s*抖音\s*$/, '').trim(),
      noWatermarkUrl: toNoWatermarkUrl(urlOrId),
      resolvedVia: 'browser_video'
    }
  } finally {
    await browser.close()
  }
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
  const errors: string[] = []

  try {
    return await tryRouterItemList(awemeId)
  } catch (e) {
    errors.push(`router_item_list: ${e instanceof Error ? e.message : e}`)
  }

  try {
    return await tryShareHtml(awemeId)
  } catch (e) {
    errors.push(`share_html: ${e instanceof Error ? e.message : e}`)
  }

  if (process.env.DOUYIN_USE_BROWSER === '1') {
    try {
      return await tryBrowserVideo(awemeId)
    } catch (e) {
      errors.push(`browser_video: ${e instanceof Error ? e.message : e}`)
    }
  } else {
    errors.push('browser_video: 未启用(设 DOUYIN_USE_BROWSER=1 且安装 puppeteer-core 可启)')
  }

  throw new Error(
    `解析失败 aweme_id=${awemeId}。步骤: ${errors.join(' → ')}`
  )
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
