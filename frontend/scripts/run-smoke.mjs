// 注浆判定冒烟测试：用 esbuild 把 TS 测试打成一个 node ESM 包再执行。
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const outfile = path.join(root, '.smoke-grouting.mjs')

await build({
  entryPoints: [path.join(root, 'smoke-grouting.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  alias: { '@': path.join(root, '..', 'src') },
  logLevel: 'warning',
})

await import(outfile)
