import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// 生成前端可读取的版本信息。
//
// build 号的含义：每次"对前端代码完成一轮改动"就加 1，不是每次执行构建都加 1。
// 因此默认只读取 .build-count 并生成文件；只有显式传入 --bump 时才递增。
// 部署前正常执行 npm run build 不会改变版本号，方便区分每次交付的版本。

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const counterFile = join(root, '.build-count')
const outFile = join(root, 'src', 'generated-build.ts')

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = String(pkg.version || '0.0.0')
const shortVersion = version.split('.').slice(0, 2).join('.')

let previous = 0
if (existsSync(counterFile)) {
  previous = Number(readFileSync(counterFile, 'utf8').trim()) || 0
} else if (existsSync(outFile)) {
  // .build-count 丢失时（例如只提交了生成文件）从已有版本号恢复，避免归零
  const m = readFileSync(outFile, 'utf8').match(/BUILD_NUMBER\s*=\s*(\d+)/)
  if (m) previous = Number(m[1]) || 0
}
const bump = process.argv.includes('--bump')
const build = bump ? previous + 1 : previous

if (bump) {
  writeFileSync(counterFile, `${build}\n`, 'utf8')
}

const content = `// 本文件由 scripts/bump-build.mjs 自动生成，请勿手动修改。
export const APP_VERSION = '${shortVersion}'
export const BUILD_NUMBER = ${build}
export const FULL_VERSION = 'v${shortVersion} build ${build}'
`

writeFileSync(outFile, content, 'utf8')
console.log(`[version] v${shortVersion} build ${build}${bump ? ' (递增)' : ''}`)
