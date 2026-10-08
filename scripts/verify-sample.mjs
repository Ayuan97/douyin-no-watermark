#!/usr/bin/env node
// 可复现验证:样例短链 → 无水印 URL → HEAD/GET 检查状态码、Content-Type、大小。
// 用法:
//   npm run verify:sample
//   DOUYIN_USE_BROWSER=1 npm run verify:sample
import { resolve } from '../dist/index.js'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

const SAMPLE = process.argv[2] || 'https://v.douyin.com/1KyuRCvMRN0/'
const EXPECT_ID = '7081608169876753702'

const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'

async function main() {
  console.log('resolve:', SAMPLE)
  let meta
  try {
    meta = await resolve(SAMPLE)
  } catch (e) {
    console.error('RESOLVE_FAIL', e instanceof Error ? e.message : e)
    console.error(
      '提示:若出现「抱歉出错了」/风控,多半是出口 IP 被抖音拦截;请在可访问抖音的网络重试,或设 DOUYIN_USE_BROWSER=1。'
    )
    process.exit(2)
  }
  console.log('meta', meta)
  if (meta.awemeId !== EXPECT_ID) {
    console.warn(`warn: awemeId=${meta.awemeId}, expected ${EXPECT_ID} for default sample`)
  }

  const headers = { 'User-Agent': UA, Referer: 'https://www.douyin.com/' }
  const head = await fetch(meta.noWatermarkUrl, { method: 'HEAD', headers, redirect: 'follow' }).catch(() => null)
  console.log(
    'HEAD',
    head && {
      status: head.status,
      contentType: head.headers.get('content-type'),
      contentLength: head.headers.get('content-length')
    }
  )

  const r = await fetch(meta.noWatermarkUrl, { headers, redirect: 'follow' })
  const ct = r.headers.get('content-type') || ''
  const cl = r.headers.get('content-length')
  console.log('GET', { status: r.status, contentType: ct, contentLength: cl })
  if (r.status !== 200) {
    console.error('DOWNLOAD_FAIL status', r.status)
    process.exit(3)
  }
  if (!/video|octet-stream|mp4/i.test(ct) && ct.includes('text/html')) {
    console.error('DOWNLOAD_FAIL got HTML, not video')
    process.exit(4)
  }
  const out = `/tmp/douyin-sample-${meta.awemeId}.bin`
  const reader = r.body
  if (!reader) {
    console.error('no body')
    process.exit(5)
  }
  let bytes = 0
  const max = 256 * 1024
  const ws = createWriteStream(out)
  const nodeReadable = Readable.fromWeb(/** @type {any} */ (reader))
  nodeReadable.on('data', (chunk) => {
    bytes += chunk.length
    if (bytes >= max) nodeReadable.destroy()
  })
  try {
    await pipeline(nodeReadable, ws)
  } catch {
    /* destroy 会触发 */
  }
  console.log('sampled_bytes', bytes, 'file', out)
  if (bytes < 10 * 1024) {
    console.error('DOWNLOAD_FAIL too small', bytes)
    process.exit(6)
  }
  console.log('OK')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
