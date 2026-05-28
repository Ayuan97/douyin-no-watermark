// 简易 CLI:解析或解析+下载。
//   tsx src/cli.ts "<分享文案/链接>"            # 只解析,打印 meta + 直链
//   tsx src/cli.ts "<分享文案/链接>" ./out      # 解析 + 下载到 ./out
import { resolve, fetchFromShare } from './index.js'

async function main(): Promise<void> {
  const [, , input, outDir] = process.argv
  if (!input) {
    console.error('用法:tsx src/cli.ts "<分享文案/链接>" [outDir]')
    process.exit(1)
  }
  if (outDir) {
    const r = await fetchFromShare(input, outDir)
    console.log(JSON.stringify(r, null, 2))
  } else {
    const meta = await resolve(input)
    console.log(JSON.stringify(meta, null, 2))
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
