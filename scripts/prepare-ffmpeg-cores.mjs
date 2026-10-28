#!/usr/bin/env node
// 把 ffmpeg 核心从 node_modules 准备到 public/，供同源加载。
// 为什么要切分：Cloudflare Pages 单文件上限 25MiB，而 wasm 有 32MB，
// 无法直接部署；这里按 PART_SIZE 切片，前端取回后拼成一个 Blob 再交给 ffmpeg。
// 产物写在 public/ 下（已被 .gitignore 忽略），由 predev / prebuild 自动生成。
//
// 同时准备两套核心：
//   ffmpeg-mt/ 多线程，需要 COOP/COEP 跨域隔离；
//   ffmpeg-st/ 单线程，不需要跨域隔离，作为隔离不可用时的同源兜底。
// 两套都在自家域名下，避免回退到第三方（Supabase）导致极慢的下载。
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

// 4MiB：单请求越小越不容易在传输途中被中间网络重置（国内访问 Cloudflare
// 时大文件单连接很容易收到 ERR_CONNECTION_RESET）。
// 配合前端的 Range 断点续传，即使中断也只补传剩余字节。
const PART_SIZE = 4 * 1024 * 1024

const TARGETS = [
  {
    label: '多线程',
    srcDir: path.join(ROOT, 'node_modules/@ffmpeg/core-mt/dist/esm'),
    outDir: path.join(ROOT, 'public/ffmpeg-mt'),
    files: [
      ['ffmpeg-core-mt-esm.js', 'ffmpeg-core.js'],
      ['ffmpeg-core-mt.wasm', 'ffmpeg-core.wasm'],
      ['ffmpeg-core-mt.worker.js', 'ffmpeg-core.worker.js'],
    ],
  },
  {
    label: '单线程',
    srcDir: path.join(ROOT, 'node_modules/@ffmpeg/core/dist/esm'),
    outDir: path.join(ROOT, 'public/ffmpeg-st'),
    files: [
      ['ffmpeg-core-esm.js', 'ffmpeg-core.js'],
      ['ffmpeg-core.wasm', 'ffmpeg-core.wasm'],
    ],
  },
]

for (const { label, srcDir, outDir, files } of TARGETS) {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  const manifest = {}
  for (const [outName, srcName] of files) {
    const srcPath = path.join(srcDir, srcName)
    if (!existsSync(srcPath)) {
      console.error(`[准备核心] 缺少 ${srcPath}，请先执行 npm install`)
      process.exit(1)
    }
    const buf = readFileSync(srcPath)
    const parts = Math.ceil(buf.byteLength / PART_SIZE)
    const chunks = []
    if (parts <= 1) {
      writeFileSync(path.join(outDir, outName), buf)
      chunks.push(buf.byteLength)
    } else {
      for (let i = 0; i < parts; i++) {
        const slice = buf.subarray(i * PART_SIZE, Math.min((i + 1) * PART_SIZE, buf.byteLength))
        writeFileSync(path.join(outDir, `${outName}.part${i}`), slice)
        chunks.push(slice.byteLength)
      }
    }
    manifest[outName] = {
      size: buf.byteLength,
      parts,
      chunks,
      // 内容指纹：前端用它做分片 URL 的版本参数。
      // 分片策略改变时文件名不变（如 part0 从 24MB 变 8MB），
      // 没有这个参数就会命中 CDN / 浏览器里旧的分片缓存，导致拼装出错。
      hash: createHash('sha1').update(buf).digest('hex').slice(0, 12),
    }
    console.log(
      `[准备核心] ${label} ${outName} -> ${parts} 片, 共 ${(buf.byteLength / 1024 / 1024).toFixed(1)}MB`
    )
  }

  writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
}

console.log('[准备核心] 完成，输出目录 public/ffmpeg-mt 与 public/ffmpeg-st')
