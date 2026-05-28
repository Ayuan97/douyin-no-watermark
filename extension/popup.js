// 抖音无水印下载 - popup 逻辑
// 解析:fetch 分享页 → 截 window._ROUTER_DATA → playwm→play 去水印
// 下载:chrome.downloads.download(saveAs: true) → Chrome 原生保存对话框
// UA/Referer 由 DNR 动态规则注入,只对扩展自己发的请求生效,绝不影响用户正常浏览。

const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
const DNR_RULE_ID = 1001

async function ensureDNRRules() {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [DNR_RULE_ID],
    addRules: [{
      id: DNR_RULE_ID,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'user-agent', operation: 'set', value: UA_MOBILE },
          { header: 'referer', operation: 'set', value: 'https://www.douyin.com/' }
        ]
      },
      condition: {
        initiatorDomains: [chrome.runtime.id],
        resourceTypes: ['xmlhttprequest', 'main_frame', 'sub_frame', 'media', 'other']
      }
    }]
  })
}

// 截取 window._ROUTER_DATA = {...} 这段 JSON(按花括号配对,跳过字符串内的括号)。
function extractRouterData(html) {
  let i = html.indexOf('window._ROUTER_DATA')
  if (i < 0) throw new Error('分享页无 _ROUTER_DATA(疑似被风控/改版)')
  i = html.indexOf('{', i)
  let depth = 0, inStr = false, esc = false, j = i
  for (; j < html.length; j++) {
    const ch = html[j]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
    } else if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) { j++; break }
  }
  return JSON.parse(html.slice(i, j))
}

async function resolveAwemeId(input) {
  const m = input.match(/https?:\/\/[^\s]+/)
  if (!m) throw new Error('未找到链接(输入需包含 http(s) 链接)')
  const url = m[0]
  let idm = url.match(/\/(?:share\/)?video\/(\d+)/)
  if (idm) return idm[1]
  // 短链:浏览器 fetch 默认 redirect: 'follow',跟到最终 URL
  const r = await fetch(url)
  idm = r.url.match(/\/(?:share\/)?video\/(\d+)/) || r.url.match(/(\d{15,})/)
  if (idm) return idm[1]
  throw new Error(`无法解析 aweme_id,最终落点:${r.url}`)
}

async function resolveMeta(input) {
  const awemeId = await resolveAwemeId(input)
  const r = await fetch(`https://www.iesdouyin.com/share/video/${awemeId}/`)
  const html = await r.text()
  const item = extractRouterData(html)?.loaderData?.['video_(id)/page']?.videoInfoRes?.item_list?.[0]
  if (!item) throw new Error('item_list 为空(图集/直播/已失效?)')
  const wm = item.video?.play_addr?.url_list?.[0]
  if (!wm) throw new Error('play_addr 为空,无可下载直链')
  return {
    awemeId: item.aweme_id || awemeId,
    author: item.author?.nickname || '',
    title: item.desc || '',
    cover: item.video?.cover?.url_list?.[0] || '',
    noWatermarkUrl: wm.replace('/aweme/v1/playwm/', '/aweme/v1/play/')
  }
}

const safeName = s => (s || '').replace(/[\\/:*?"<>|\n\r\t#]/g, '_').slice(0, 60).trim() || 'video'

const $ = id => document.getElementById(id)
const setStatus = s => { $('status').textContent = s }
const showError = msg => { const el = $('error'); el.textContent = msg; el.classList.add('show') }
const clearError = () => $('error').classList.remove('show')

let currentMeta = null

async function onParse() {
  clearError()
  $('result').classList.remove('show')
  const input = $('input').value.trim()
  if (!input) { showError('请粘贴分享文案或链接'); return }
  $('btn-parse').disabled = true
  setStatus('解析中…')
  try {
    await ensureDNRRules()
    const meta = await resolveMeta(input)
    currentMeta = meta
    $('author').textContent = meta.author
    $('title').textContent = meta.title
    $('url').textContent = meta.noWatermarkUrl
    const cover = $('cover')
    if (meta.cover) { cover.src = meta.cover; cover.classList.add('show') }
    else { cover.classList.remove('show') }
    $('result').classList.add('show')
    setStatus('解析成功')
  } catch (e) {
    showError(e?.message || String(e))
    setStatus('')
  } finally {
    $('btn-parse').disabled = false
  }
}

function onDownload() {
  if (!currentMeta) return
  const filename = `${safeName(currentMeta.author)}_${safeName(currentMeta.title)}.mp4`
  chrome.downloads.download(
    { url: currentMeta.noWatermarkUrl, filename, saveAs: true },
    id => {
      if (chrome.runtime.lastError) showError('下载失败:' + chrome.runtime.lastError.message)
      else setStatus(`已发起下载 #${id}`)
    }
  )
}

async function onCopy() {
  if (!currentMeta) return
  try {
    await navigator.clipboard.writeText(currentMeta.noWatermarkUrl)
    setStatus('已复制直链')
    setTimeout(() => setStatus(''), 2000)
  } catch (e) {
    showError('复制失败:' + (e?.message || String(e)))
  }
}

document.addEventListener('DOMContentLoaded', () => {
  $('btn-parse').addEventListener('click', onParse)
  $('btn-download').addEventListener('click', onDownload)
  $('btn-copy').addEventListener('click', onCopy)
  $('input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) onParse()
  })
})
