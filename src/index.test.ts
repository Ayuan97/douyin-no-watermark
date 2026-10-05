import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve, toNoWatermarkUrl } from './index.js'

test('toNoWatermarkUrl replaces playwm path', () => {
  const u = toNoWatermarkUrl(
    'https://aweme.snssdk.com/aweme/v1/playwm/?video_id=v0200fg10000c854e7jc77u3q4i0j0hg&ratio=720p&line=0'
  )
  assert.match(u, /\/aweme\/v1\/play\/\?/)
  assert.doesNotMatch(u, /playwm/)
})

test('toNoWatermarkUrl builds iesdouyin play from bare video_id', () => {
  const u = toNoWatermarkUrl('v0200fg10000c854e7jc77u3q4i0j0hg')
  assert.equal(
    u,
    'https://www.iesdouyin.com/aweme/v1/play/?video_id=v0200fg10000c854e7jc77u3q4i0j0hg&ratio=720p&line=0'
  )
})

test(
  'sample shortlink resolves to downloadable no-watermark video',
  { skip: process.env.DOUYIN_NETWORK_TEST !== '1' },
  async () => {
    const meta = await resolve('https://v.douyin.com/1KyuRCvMRN0/')
    assert.equal(meta.awemeId, '7081608169876753702')
    assert.ok(meta.noWatermarkUrl.includes('/play'))
    const r = await fetch(meta.noWatermarkUrl, {
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
        Referer: 'https://www.douyin.com/'
      },
      redirect: 'follow'
    })
    assert.equal(r.status, 200, `play URL HTTP ${r.status}`)
    const ct = r.headers.get('content-type') || ''
    assert.match(ct, /video|octet-stream|mp4/i, `content-type=${ct}`)
    const len = Number(r.headers.get('content-length') || 0)
    // 读一小段确认非 HTML
    const buf = new Uint8Array(await r.arrayBuffer())
    assert.ok(buf.byteLength > 10 * 1024, `body too small: ${buf.byteLength}`)
    if (len) assert.ok(len > 10 * 1024, `content-length too small: ${len}`)
    console.log(
      JSON.stringify({
        resolvedVia: meta.resolvedVia,
        status: r.status,
        contentType: ct,
        bytes: buf.byteLength,
        contentLength: len || null,
        urlHost: new URL(meta.noWatermarkUrl).host
      })
    )
  }
)
