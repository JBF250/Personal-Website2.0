import { useState, useRef, useCallback, useEffect } from 'react'
import { useI18n } from '@/context/I18nContext'
import { LabLayout } from './LabLayout'
import { Upload, Download, FileImage, Music, Scissors, Loader2, AlertCircle, CheckCircle } from 'lucide-react'

type ConvertTab = 'image' | 'audio' | 'extract'

interface ConvertConfig {
  [key: string]: any
}

const STORAGE_KEY = 'lab_converter_config'
const SUPABASE_URL = 'https://noiebpjyskscjtmdytxj.supabase.co'
// 核心库托管地址。可用环境变量 VITE_FFMPEG_CORE_BASE 覆盖（例如换成国内 CDN /
// Cloudflare R2）——Supabase Storage 在部分网络下对 30MB 大文件的吞吐极低。
const CORE_BASE = import.meta.env.VITE_FFMPEG_CORE_BASE || `${SUPABASE_URL}/storage/v1/object/public/ffmpeg-core`
// 同源核心目录：由 scripts/prepare-ffmpeg-cores.mjs 在 predev/prebuild 时生成到 public/。
// 同源加载没有跨域与第三方 CDN 限速问题，是首选路径；wasm 超过 Pages 单文件上限，被切成多片。
// mt 需要 COOP/COEP 跨域隔离；st 不需要隔离，作为隔离不可用时的同源兜底。
const LOCAL_CORE_BASE = { mt: '/ffmpeg-mt', st: '/ffmpeg-st' } as const
type CoreKind = 'mt' | 'st'

type CoreFileInfo = { size: number; parts: number; chunks?: number[]; hash?: string }

const localCoreManifests: Record<CoreKind, Record<string, CoreFileInfo> | null> = {
  mt: null,
  st: null,
}

async function loadLocalCoreManifest(kind: CoreKind): Promise<Record<string, CoreFileInfo>> {
  const cached = localCoreManifests[kind]
  if (cached) return cached
  const ac = new AbortController()
  const timer = window.setTimeout(() => ac.abort(), 10000)
  try {
    const resp = await fetch(`${LOCAL_CORE_BASE[kind]}/manifest.json`, {
      signal: ac.signal,
      // 清单必须拿到最新的：分片数量/大小可能随构建变化
      cache: 'no-store',
    })
    if (!resp.ok) throw new Error(`本地核心清单不可用 (HTTP ${resp.status})`)
    const manifest = (await resp.json()) as Record<string, CoreFileInfo>
    localCoreManifests[kind] = manifest
    return manifest
  } finally {
    clearTimeout(timer)
  }
}

// [文件名, MIME, 加载进度区间起点, 终点]：加载阶段占 2%~45%，转换阶段占 45%~100%
const MT_FILES: [string, string, number, number][] = [
  ['ffmpeg-core-mt-esm.js', 'text/javascript', 2, 4],
  ['ffmpeg-core-mt.wasm', 'application/wasm', 4, 42],
  ['ffmpeg-core-mt.worker.js', 'text/javascript', 42, 45],
]
const ST_FILES: [string, string, number, number][] = [
  ['ffmpeg-core-esm.js', 'text/javascript', 2, 4],
  ['ffmpeg-core.wasm', 'application/wasm', 4, 45],
]

type CoreProgress = (pct: number, msg?: string) => void

// 同源分片下载的空闲超时与重试次数。
// 没有超时保护时，一旦连接被中间网络挂起就会一直停在某个百分比（用户侧表现为卡半小时）。
const LOCAL_IDLE_TIMEOUT = 15000
const LOCAL_MAX_ATTEMPTS = 6

/**
 * 下载一个核心分片。
 * 关键点：连接被重置时用 Range 从已接收的字节处续传，而不是从头重下。
 * 国内访问 Cloudflare 时大文件传输经常收到 ERR_CONNECTION_RESET，
 * 只有续传才能保证 30MB 的文件最终能拼完。
 */
async function fetchCorePart(
  url: string,
  expectedSize: number | null,
  onBytes: (n: number) => void
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let received = 0
  let attempt = 0
  let lastErr: any

  const finished = () => expectedSize !== null && received >= expectedSize

  while (!finished()) {
    if (attempt >= LOCAL_MAX_ATTEMPTS) {
      const name = url.split('/').pop()
      throw new Error(
        `${name} 传输中断 (${received}/${expectedSize ?? '?'} 字节)：${lastErr?.message || lastErr}`
      )
    }
    attempt++

    const ac = new AbortController()
    let idleTimer: number | undefined
    const resetIdle = () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      idleTimer = window.setTimeout(() => ac.abort(), LOCAL_IDLE_TIMEOUT)
    }
    resetIdle()

    try {
      const headers: Record<string, string> = {}
      // 断点续传：只请求尚未收到的部分
      if (received > 0) headers.Range = `bytes=${received}-`

      const resp = await fetch(url, {
        headers,
        signal: ac.signal,
        // 避免命中"上次被截断的缓存副本"
        cache: 'no-store',
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)

      // 服务器不支持 Range，返回的是完整文件：丢弃已收部分重新累积
      if (received > 0 && resp.status === 200) {
        chunks.length = 0
        received = 0
      }

      const reader = resp.body?.getReader()
      if (!reader) {
        const buf = new Uint8Array(await resp.arrayBuffer())
        chunks.push(buf)
        received += buf.byteLength
        onBytes(received)
      } else {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (value?.length) {
            chunks.push(value)
            received += value.length
            onBytes(received)
            resetIdle()
            if (expectedSize !== null && received >= expectedSize) break
          }
        }
      }

      // 没有预期长度（旧版 manifest）时，读到流结束即视为完成
      if (expectedSize === null) break
    } catch (e) {
      lastErr = e
      // 已收到的字节保留在 chunks 里，下一轮从断点继续
      if (expectedSize === null || received < expectedSize) {
        await new Promise((r) => window.setTimeout(r, 500 * attempt))
        continue
      }
    } finally {
      if (idleTimer !== undefined) clearTimeout(idleTimer)
    }
  }

  const merged = new Uint8Array(received)
  let offset = 0
  for (const c of chunks) {
    merged.set(c, offset)
    offset += c.length
  }
  return merged
}

// 同源核心的字节只取一次：后台预载与点击转换共用同一个 Promise，
// 结果（blob URL）缓存在这里，避免重复下载。失败时清空以便下次重试。
type CoreAssets = { coreURL: string; wasmURL: string; workerURL?: string }

const localCoreAssets: Record<CoreKind, Promise<CoreAssets> | null> = { mt: null, st: null }
let localCoreProgress: CoreProgress | null = null

function loadLocalCoreAssets(kind: CoreKind, onProgress?: CoreProgress) {
  localCoreProgress = onProgress ?? null
  const cached = localCoreAssets[kind]
  if (cached) return cached

  const promise = (async () => {
    const manifest = await loadLocalCoreManifest(kind)
    const files = kind === 'mt' ? MT_FILES : ST_FILES
    const urls: string[] = []
    for (const [file, mime, from, to] of files) {
      const info = manifest[file]
      if (!info) throw new Error(`本地核心缺少 ${file}`)
      localCoreProgress?.(from, info.parts > 1 ? `[下载] ${file} (同源, ${info.parts} 片)` : `[下载] ${file} (同源)`)
      const parts = info.parts <= 1 ? [file] : Array.from({ length: info.parts }, (_, i) => `${file}.part${i}`)
      const chunks: Uint8Array[] = []
      let done = 0
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]
        // manifest 里记录了每片的确切字节数，用于断点续传时判断是否传完
        const expected = info.chunks?.[i] ?? (parts.length === 1 ? info.size : null)
        // 带内容指纹：避免命中旧的分片缓存（文件名不变但切分方式变了）
        const version = info.hash ? `?v=${info.hash}` : ''
        const buf = await fetchCorePart(`${LOCAL_CORE_BASE[kind]}/${part}${version}`, expected, (n) => {
          const current = done + n
          localCoreProgress?.(Math.max(from, Math.min(to, Math.round(from + (current / info.size) * (to - from)))))
        })
        chunks.push(buf)
        done += buf.byteLength
        localCoreProgress?.(Math.max(from, Math.min(to, Math.round(from + (done / info.size) * (to - from)))))
      }
      if (done !== info.size) throw new Error(`${file} 拼装不完整 (${done}/${info.size})`)
      // 一律转成 blob URL：dev 下 Vite 不允许把 /public 里的文件当模块 import，
      // 而 ffmpeg 核心内部会对 coreURL 做 import()、对 workerURL 做 new Worker()。
      urls.push(URL.createObjectURL(new Blob(chunks as BlobPart[], { type: mime })))
    }
    localCoreProgress?.(45)
    return { coreURL: urls[0], wasmURL: urls[1], workerURL: urls[2] }
  })()

  localCoreAssets[kind] = promise
  promise.catch(() => { localCoreAssets[kind] = null })
  return promise
}

export default function ConverterPage() {
  const { t } = useI18n()
  const [activeTab, setActiveTab] = useState<ConvertTab>('image')
  const [file, setFile] = useState<File | null>(null)
  const [outputFormat, setOutputFormat] = useState<string>('')
  const [quality, setQuality] = useState(1)
  const [scaleWidth, setScaleWidth] = useState('')
  const [scaleHeight, setScaleHeight] = useState('')
  const [audioBitrate, setAudioBitrate] = useState('320k')
  const [audioSampleRate, setAudioSampleRate] = useState('48000')
  const [volumeGain, setVolumeGain] = useState(0)
  const [trimStart, setTrimStart] = useState('')
  const [trimEnd, setTrimEnd] = useState('')
  const [converting, setConverting] = useState(false)
  const [progress, setProgress] = useState(0)
  const [logs, setLogs] = useState<string[]>([])
  const [result, setResult] = useState<Blob | null>(null)
  const [exportName, setExportName] = useState('')
  const [error, setError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  // 单个 FFmpeg 实例（单线程核心），音频转换与音频提取共用
  const ffmpegRef = useRef<any>(null)
  // 取消标记：用户在转换过程中移除文件时置位，用于废弃进行中的任务
  const cancelRef = useRef(false)
  const logBufferRef = useRef<string[]>([])
  const logFlushTimerRef = useRef<number | null>(null)

  // Load saved config
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      try {
        const config = JSON.parse(saved)
        setOutputFormat(config.outputFormat || '')
        setQuality(config.quality || 1)
        setAudioBitrate(config.audioBitrate || '320k')
        setAudioSampleRate(config.audioSampleRate || '48000')
        setVolumeGain(config.volumeGain || 0)
        setTrimStart(config.trimStart || '')
        setTrimEnd(config.trimEnd || '')
      } catch { /* ignore */ }
    }
  }, [])

  // Save config
  useEffect(() => {
    const config: ConvertConfig = {
      outputFormat, quality, audioBitrate, audioSampleRate, volumeGain, trimStart, trimEnd,
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
  }, [outputFormat, quality, audioBitrate, audioSampleRate, volumeGain, trimStart, trimEnd])

  const flushLogs = useCallback(() => {
    logFlushTimerRef.current = null
    if (logBufferRef.current.length === 0) return
    const buffered = logBufferRef.current
    logBufferRef.current = []
    setLogs((prev) => {
      const combined = [...prev, ...buffered]
      return combined.length > 200 ? combined.slice(-200) : combined
    })
  }, [])

  const addLog = useCallback((msg: string) => {
    logBufferRef.current.push(`[${new Date().toLocaleTimeString()}] ${msg}`)
    if (logFlushTimerRef.current === null) {
      logFlushTimerRef.current = window.setTimeout(flushLogs, 150)
    }
  }, [flushLogs])

  useEffect(() => {
    return () => {
      if (logFlushTimerRef.current !== null) {
        clearTimeout(logFlushTimerRef.current)
        logFlushTimerRef.current = null
      }
    }
  }, [])

  // 音频相关页签才需要 ffmpeg 核心：切过去就开始预载，把等待藏在选文件/调参数的时间里。
  // 图片转换由 Canvas 完成，完全不需要这 30MB，因此停留在图片页签时不做任何下载。
  useEffect(() => {
    if ((navigator as any).connection?.saveData) return
    if (activeTab === 'image') return

    // 跨域隔离可用时用多线程，否则用同样免隔离的单线程核心；两者都走同源
    const isolated = typeof SharedArrayBuffer !== 'undefined' && !!(window as any).crossOriginIsolated
    const kind: CoreKind = isolated ? 'mt' : 'st'

    const timer = window.setTimeout(() => {
      loadLocalCoreAssets(kind).catch(() => { /* 点转换时会走完整降级链路 */ })
    }, 300)
    return () => clearTimeout(timer)
  }, [activeTab])

  // FFmpeg 单例初始化：优先使用同源核心（mt 需要跨域隔离，st 不需要），
  // 同源全部失败时才回退远程（Supabase）。
  const initFfmpeg = useCallback(async () => {
    if (ffmpegRef.current) return ffmpegRef.current
    try {
      const { FFmpeg } = await import('@ffmpeg/ffmpeg')

      const crossOriginIsolated = typeof SharedArrayBuffer !== 'undefined' && !!(window as any).crossOriginIsolated
      addLog(crossOriginIsolated ? '加载 ffmpeg 多线程核心库...' : t('lab.converter.loadingFfmpeg'))

      const build = () => {
        const f = new FFmpeg()
        f.on('log', ({ message }: { message: string }) => addLog(message))
        // 转换阶段的进度 → 45%~100%（核心库加载阶段不产生 progress 事件）
        f.on('progress', ({ progress: p }: { progress: number }) => {
          setProgress(Math.max(45, Math.min(100, Math.round(45 + p * 55))))
        })
        return f
      }

      const loadWith = async (f: any, cfg: any) => {
        await Promise.race([
          f.load(cfg),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('FFmpeg 核心库加载超时 (90s)')), 90000)),
        ])
      }

      // 核心库下载：分片（Range）下载 + 每片超时与长度校验。
      // 背景：单次长连接拉 30MB 在部分网络下会被中断或无限挂起（表现为一直 0%），
      // 而浏览器受 CORS 限制拿不到 Content-Range，无法从响应得知文件总长，
      // 因此用固定的预期字节数算进度并做完整性校验。
      // 注意：升级 @ffmpeg/core / @ffmpeg/core-mt 版本后需同步更新下表数值。
      const SIZES: Record<string, number> = {
        'ffmpeg-core-mt-esm.js': 128947,
        'ffmpeg-core-mt.wasm': 32718323,
        'ffmpeg-core-mt.worker.js': 2115,
        'ffmpeg-core-esm.js': 114494,
        'ffmpeg-core.wasm': 32129114,
      }
      const CHUNK_SIZE = 4 * 1024 * 1024
      // 空闲超时：只要还在持续收到数据就不算超时（慢速网络也能走完），
      // 只有连续 IDLE_TIMEOUT 毫秒收不到任何字节才判定为卡死并重试该片。
      const IDLE_TIMEOUT = 15000

      const fetchCore = async (file: string, mime: string, noStore: boolean, from: number, to: number) => {
        const expect = SIZES[file] || 0
        const t0 = Date.now()
        addLog(`[下载] ${file} ...`)
        const parts: Uint8Array[] = []
        let offset = 0
        for (;;) {
          const end = offset + CHUNK_SIZE - 1
          let chunk: Uint8Array | null = null
          let lastErr: any = null
          for (let attempt = 1; attempt <= 4 && !chunk; attempt++) {
            const ac = new AbortController()
            let idleTimer: number | undefined
            const resetIdle = () => {
              if (idleTimer !== undefined) clearTimeout(idleTimer)
              idleTimer = window.setTimeout(() => ac.abort(), IDLE_TIMEOUT)
            }
            resetIdle()
            try {
              const resp = await fetch(`${CORE_BASE}/${file}`, {
                headers: { Range: `bytes=${offset}-${end}` },
                cache: noStore ? 'no-store' : 'default',
                signal: ac.signal,
              })
              if (resp.status !== 206 && resp.status !== 200) throw new Error(`HTTP ${resp.status}`)
              // 注意：不能用 content-length 预分配缓冲区——JS 文件会被 gzip 传输，
              // 该头是压缩后的大小，与实际解压后的字节数不一致。改为动态累积，
              // 最终用预期总长（SIZES）校验完整性。
              const got: Uint8Array[] = []
              let n = 0
              const reader = resp.body?.getReader()
              if (reader) {
                for (;;) {
                  const { done, value } = await reader.read()
                  if (done) break
                  if (value?.length) {
                    got.push(value)
                    n += value.length
                    resetIdle()
                    // 边下边推进进度，让慢速网络下也能看出仍在传输
                    const est = expect || Math.max(offset + n, 1)
                    setProgress(Math.max(from, Math.min(to, Math.round(from + ((offset + n) / est) * (to - from)))))
                  }
                }
              } else {
                const b = new Uint8Array(await resp.arrayBuffer())
                got.push(b)
                n = b.byteLength
              }
              if (!n) throw new Error('响应为空')
              const merged = new Uint8Array(n)
              let cursor = 0
              for (const p of got) {
                merged.set(p, cursor)
                cursor += p.length
              }
              chunk = merged
            } catch (e) {
              lastErr = e
              if (attempt < 4) {
                addLog(`[下载] ${file} 第 ${Math.floor(offset / CHUNK_SIZE) + 1} 片失败，重试 (${attempt}/4)...`)
                await new Promise((r) => setTimeout(r, 800 * attempt))
              }
            } finally {
              if (idleTimer !== undefined) clearTimeout(idleTimer)
            }
          }
          if (!chunk) throw new Error(`下载 ${file} 失败：${lastErr?.message || lastErr}`)
          parts.push(chunk)
          offset += chunk.byteLength
          const total = expect || Math.max(offset, 1)
          setProgress(Math.max(from, Math.min(to, Math.round(from + (offset / total) * (to - from)))))
          // 短读即到达文件末尾（浏览器拿不到 Content-Range，只能这样判断）
          if (chunk.byteLength < CHUNK_SIZE) break
        }
        if (expect && offset !== expect) throw new Error(`下载 ${file} 不完整 (${offset}/${expect})`)
        addLog(`[下载] ${file} 完成 (${(offset / 1024 / 1024).toFixed(1)}MB, ${((Date.now() - t0) / 1000).toFixed(1)}s)`)
        return URL.createObjectURL(new Blob(parts as BlobPart[], { type: mime }))
      }

      // 主路径下载：与 2.7 一样「一次请求整取」，但必须可中断——
      // toBlobURL 内部无法中止，连接一旦卡死就会永远等下去，降级分支也就永远走不到。
      // 用「空闲超时」代替总时长限制：只要还在持续收到数据就不打断（慢速网络能走完），
      // 连续 IDLE_TIMEOUT 收不到任何字节才中止，交给分片下载去重试。
      const fetchWhole = async (file: string, mime: string, from: number, to: number) => {
        const expect = SIZES[file] || 0
        const t0 = Date.now()
        addLog(`[下载] ${file} ...`)
        const ac = new AbortController()
        let idleTimer: number | undefined
        const resetIdle = () => {
          if (idleTimer !== undefined) clearTimeout(idleTimer)
          idleTimer = window.setTimeout(() => ac.abort(), IDLE_TIMEOUT)
        }
        resetIdle()
        try {
          const resp = await fetch(`${CORE_BASE}/${file}`, { signal: ac.signal })
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
          const got: Uint8Array[] = []
          let n = 0
          const reader = resp.body?.getReader()
          if (reader) {
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              if (value?.length) {
                got.push(value)
                n += value.length
                resetIdle()
                const est = expect || Math.max(n, 1)
                setProgress(Math.max(from, Math.min(to, Math.round(from + (n / est) * (to - from)))))
              }
            }
          } else {
            const b = new Uint8Array(await resp.arrayBuffer())
            got.push(b)
            n = b.byteLength
          }
          if (expect && n !== expect) throw new Error(`下载不完整 (${n}/${expect})`)
          addLog(`[下载] ${file} 完成 (${(n / 1024 / 1024).toFixed(1)}MB, ${((Date.now() - t0) / 1000).toFixed(1)}s)`)
          return URL.createObjectURL(new Blob(got as BlobPart[], { type: mime }))
        } finally {
          if (idleTimer !== undefined) clearTimeout(idleTimer)
        }
      }

      const withTimeout = <T,>(p: Promise<T>, ms: number, what: string): Promise<T> =>
        Promise.race([
          p,
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} 超时 (${ms / 1000}s)`)), ms)),
        ])

      const loadChunkedCore = async (kind: 'mt' | 'st', noStore: boolean) => {
        const f = build()
        try {
          const files = kind === 'mt' ? MT_FILES : ST_FILES
          const urls = await withTimeout(
            (async () => {
              const out: string[] = []
              for (const [file, mime, from, to] of files) {
                out.push(await fetchCore(file, mime, noStore, from, to))
              }
              return out
            })(),
            600000,
            '核心库下载'
          )
          const cfg: any = { coreURL: urls[0], wasmURL: urls[1] }
          if (urls[2]) cfg.workerURL = urls[2]
          await loadWith(f, cfg)
          return f
        } catch (e) {
          try { f.terminate() } catch { /* ignore */ }
          throw e
        }
      }

      // 主路径：与 2.7 一致——每个文件一次请求整取（不分片）+ 60s 加载超时。
      const loadSimple = async (kind: 'mt' | 'st') => {
        const f = build()
        try {
          const files = kind === 'mt' ? MT_FILES : ST_FILES
          const urls: string[] = []
          for (const [file, mime, from, to] of files) {
            urls.push(await fetchWhole(file, mime, from, to))
          }
          const cfg: any = { coreURL: urls[0], wasmURL: urls[1] }
          if (urls[2]) cfg.workerURL = urls[2]
          await withTimeout(f.load(cfg), 60000, 'FFmpeg 核心库加载')
          return f
        } catch (e) {
          try { f.terminate() } catch { /* ignore */ }
          throw e
        }
      }

      // 首选路径：同源核心。无跨域、无第三方限速，wasm 分片取回后拼成 Blob 交给 ffmpeg。
      // mt 需要跨域隔离；st 不需要，因此任何环境都能走同源。
      const loadLocal = async (kind: 'mt' | 'st') => {
        const f = build()
        try {
          // 复用（可能已由后台预载完成的）同源核心，只创建一个 FFmpeg 实例
          const assets = await loadLocalCoreAssets(kind, (pct, msg) => {
            if (msg) addLog(msg)
            setProgress(pct)
          })
          await withTimeout(
            f.load({ coreURL: assets.coreURL, wasmURL: assets.wasmURL, workerURL: assets.workerURL }),
            60000,
            'FFmpeg 核心库加载'
          )
          return f
        } catch (e) {
          try { f.terminate() } catch { /* ignore */ }
          throw e
        }
      }

      // 主路径失败（被中断/超时/缓存了截断副本）时降级：
      // 分片下载 + 空闲超时重试 + 完整性校验，并绕过浏览器缓存。
      const tryLoad = async (kind: 'mt' | 'st') => {
        try {
          return await loadSimple(kind)
        } catch (e: any) {
          addLog(`核心库加载失败，改用分片下载重试...（${String(e?.message || e).slice(0, 70)}）`)
          return await loadChunkedCore(kind, true)
        }
      }

      const adopt = (f: any) => {
        if (cancelRef.current) {
          try { f.terminate() } catch { /* ignore */ }
          return null
        }
        ffmpegRef.current = f
        setProgress(50)
        return f
      }

      // 1) 跨域隔离可用时优先同源多线程
      if (crossOriginIsolated) {
        try {
          const mt = await loadLocal('mt')
          addLog('ffmpeg 多线程核心库加载完成（同源）')
          return adopt(mt)
        } catch (e: any) {
          addLog(`同源多线程核心不可用，改用单线程（${String(e?.message || e).slice(0, 60)}）`)
        }
      }

      // 2) 同源单线程：不需要跨域隔离，任何环境都可用。
      //    放在远程回退之前，避免在跨域隔离失效时被迫从 Supabase 下载 32MB。
      try {
        const st = await loadLocal('st')
        addLog('ffmpeg 单线程核心库加载完成（同源）')
        return adopt(st)
      } catch (e: any) {
        addLog(`同源单线程核心不可用，改用远程加载（${String(e?.message || e).slice(0, 60)}）`)
      }

      // 3) 远程核心（Supabase）：仅在同源全部失败时使用
      if (crossOriginIsolated) {
        try {
          const mt = await tryLoad('mt')
          addLog('ffmpeg 多线程核心库加载完成（远程）')
          return adopt(mt)
        } catch (e: any) {
          console.error('FFmpeg MT 初始化失败，回退单线程:', e)
          addLog(`多线程核心不可用，回退单线程（${String(e?.message || e).slice(0, 60)}）`)
        }
      }

      const st = await tryLoad('st')
      addLog('ffmpeg 核心库加载完成（远程）')
      return adopt(st)
    } catch (err: any) {
      console.error('FFmpeg init error:', err)
      setError(err.message || t('lab.converter.ffmpegLoadError'))
      return null
    }
  }, [addLog, t])

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0]
    if (selected) {
      cancelRef.current = false
      setError(''); setResult(null); setProgress(0); setLogs([]); logBufferRef.current = []
      if (selected.size > 500 * 1024 * 1024) { setError(t('lab.converter.fileTooLarge')); return }
      setFile(selected)
      setExportName(selected.name.replace(/\.[^.]+$/, ''))
      const ext = selected.name.split('.').pop()?.toLowerCase()
      setOutputFormat(getDefaultOutputFormat(activeTab, ext))
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const dropped = e.dataTransfer.files[0]
    if (dropped) {
      cancelRef.current = false
      setError(''); setResult(null); setProgress(0); setLogs([]); logBufferRef.current = []
      if (dropped.size > 500 * 1024 * 1024) { setError(t('lab.converter.fileTooLarge')); return }
      setFile(dropped)
      setExportName(dropped.name.replace(/\.[^.]+$/, ''))
      const ext = dropped.name.split('.').pop()?.toLowerCase()
      setOutputFormat(getDefaultOutputFormat(activeTab, ext))
    }
  }

  const getDefaultOutputFormat = (tab: ConvertTab, _inputExt?: string): string => {
    switch (tab) {
      case 'image': return 'png'
      case 'audio': return 'mp3'
      case 'extract': return 'mp3'
      default: return ''
    }
  }

  const convertImage = async () => {
    if (!file || !outputFormat) return
    cancelRef.current = false
    setConverting(true); setProgress(0); setError('')
    addLog(t('lab.converter.startingConversion'))
    try {
      const img = new Image()
      const url = URL.createObjectURL(file)
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error('Failed to load image'))
        img.src = url
      })
      const canvas = document.createElement('canvas')
      let targetWidth = img.width, targetHeight = img.height
      if (scaleWidth && scaleHeight) { targetWidth = parseInt(scaleWidth); targetHeight = parseInt(scaleHeight) }
      else if (scaleWidth) { targetWidth = parseInt(scaleWidth); targetHeight = Math.round(img.height * (targetWidth / img.width)) }
      else if (scaleHeight) { targetHeight = parseInt(scaleHeight); targetWidth = Math.round(img.width * (targetHeight / img.height)) }
      canvas.width = targetWidth; canvas.height = targetHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Canvas context not available')
      ctx.drawImage(img, 0, 0, targetWidth, targetHeight)
      URL.revokeObjectURL(url)
      addLog(t('lab.converter.processing'))
      const blob = await new Promise<Blob>((resolve) => { canvas.toBlob((b) => resolve(b!), `image/${outputFormat}`, quality) })
      setResult(blob); setProgress(100)
      addLog(t('lab.converter.conversionComplete'))
    } catch (err: any) {
      setError(err.message || t('lab.converter.conversionFailed'))
      addLog(t('lab.converter.conversionFailed'))
    } finally { setConverting(false) }
  }

  const uint8ArrayToBlob = (data: Uint8Array, mimeType: string): Blob => {
    return new Blob([data.buffer as ArrayBuffer], { type: mimeType })
  }

  const convertWithFfmpeg = async (tab: 'audio' | 'extract') => {
    if (!file || !outputFormat) return
    cancelRef.current = false
    setConverting(true); setProgress(0); setError('')

    const sizeMB = (file.size / (1024 * 1024)).toFixed(1)
    if (tab === 'extract' && file.size > 50 * 1024 * 1024) {
      addLog(`警告: 文件较大 (${sizeMB}MB)，浏览器端处理可能需要5-15分钟`)
    } else {
      addLog(`文件大小: ${sizeMB}MB`)
    }

    try {
      const ffmpeg = await initFfmpeg()
      if (!ffmpeg || cancelRef.current) return

      addLog(t('lab.converter.startingConversion'))
      const inputName = file.name
      const outputName = `output.${outputFormat}`
      const fileBuffer = await file.arrayBuffer()
      setProgress(52)
      await ffmpeg.writeFile(inputName, new Uint8Array(fileBuffer))
      addLog(t('lab.converter.inputLoaded'))
      setProgress(56)

      const args = ['-i', inputName]

      if (tab === 'audio') {
        // 裁剪：起始时间（需在 -i 之前）
        if (trimStart) {
          args.push('-ss', trimStart)
        }
        if (outputFormat === 'mp3') args.push('-c:a', 'libmp3lame')
        else if (outputFormat === 'wav') args.push('-c:a', 'pcm_s16le')
        else if (outputFormat === 'm4a') args.push('-c:a', 'aac', '-f', 'ipod')
        else if (outputFormat === 'ogg') args.push('-c:a', 'libvorbis', '-f', 'ogg')
        // 音量增益
        if (volumeGain !== 0) {
          args.push('-af', `volume=${volumeGain}dB`)
        }
        // 裁剪：结束时间
        if (trimEnd) {
          args.push('-to', trimEnd)
        }
        args.push('-b:a', audioBitrate, '-ar', audioSampleRate)
      } else {
        args.push('-vn')
        if (outputFormat === 'mp3') args.push('-c:a', 'libmp3lame')
        else if (outputFormat === 'wav') args.push('-c:a', 'pcm_s16le')
        else if (outputFormat === 'm4a') args.push('-c:a', 'aac', '-f', 'ipod')
        else if (outputFormat === 'ogg') args.push('-c:a', 'libvorbis', '-f', 'ogg')
        args.push('-b:a', audioBitrate)
      }

      args.push('-y', outputName)
      addLog(t('lab.converter.processing'))
      setProgress(58)

      await Promise.race([
        ffmpeg.exec(args),
        new Promise((_, reject) => setTimeout(() => reject(new Error('转换超时 (120s)')), 120000)),
      ])
      if (cancelRef.current) return
      setProgress(85)
      addLog(t('lab.converter.readingOutput'))
      const outputData = await ffmpeg.readFile(outputName)
      setProgress(92)
      const getMimeType = () => {
        if (outputFormat === 'mp3') return 'audio/mpeg'
        if (outputFormat === 'm4a') return 'audio/mp4'
        if (outputFormat === 'ogg') return 'audio/ogg'
        if (outputFormat === 'wav') return 'audio/wav'
        return 'application/octet-stream'
      }
      const blob = uint8ArrayToBlob(outputData as Uint8Array, getMimeType())
      setProgress(95)
      await ffmpeg.deleteFile(inputName)
      await ffmpeg.deleteFile(outputName)
      if (cancelRef.current) return
      setResult(blob); setProgress(100)
      addLog(t('lab.converter.conversionComplete'))
    } catch (err: any) {
      // 用户取消（移除文件）导致的失败不提示
      if (cancelRef.current) return
      setError(err.message || t('lab.converter.conversionFailed'))
      addLog(t('lab.converter.conversionFailed'))
    } finally {
      if (!cancelRef.current) setConverting(false)
    }
  }

  // 移除已导入文件：中断进行中的转换并复位所有状态（避免标签页被 disabled 卡住）
  const handleRemoveFile = () => {
    cancelRef.current = true
    try { ffmpegRef.current?.terminate() } catch { /* ignore */ }
    ffmpegRef.current = null
    setFile(null)
    setResult(null)
    setConverting(false)
    setProgress(0)
    setError('')
    setLogs([])
    logBufferRef.current = []
  }

  const handleConvert = async () => {
    switch (activeTab) {
      case 'image': await convertImage(); break
      case 'audio': case 'extract': await convertWithFfmpeg(activeTab); break
    }
  }

  const getResultName = () => `${exportName.trim() || 'converted'}.${outputFormat}`

  const handleDownloadResult = () => {
    if (!result) return
    const url = URL.createObjectURL(result)
    const a = document.createElement('a')
    a.href = url; a.download = getResultName()
    a.click(); URL.revokeObjectURL(url)
  }

  const tabs = [
    { id: 'image' as ConvertTab, icon: FileImage, label: t('lab.converter.imageTab') },
    { id: 'audio' as ConvertTab, icon: Music, label: t('lab.converter.audioTab') },
    { id: 'extract' as ConvertTab, icon: Scissors, label: t('lab.converter.extractTab') },
  ]

  const formatOptions: Record<ConvertTab, { value: string; label: string }[]> = {
    image: [
      { value: 'png', label: 'PNG' },
      { value: 'jpg', label: 'JPG' },
      { value: 'webp', label: 'WebP' },
    ],
    audio: [
      { value: 'mp3', label: 'MP3' },
      { value: 'm4a', label: 'M4A' },
      { value: 'ogg', label: 'OGG' },
      { value: 'wav', label: 'WAV' },
    ],
    extract: [
      { value: 'mp3', label: 'MP3' },
      { value: 'm4a', label: 'M4A' },
      { value: 'ogg', label: 'OGG' },
      { value: 'wav', label: 'WAV' },
    ],
  }

  return (
    <LabLayout
      title={t('lab.tools.converter.title')}
      description={t('lab.tools.converter.desc')}
    >
      <div className="space-y-6">
        {/* Tabs */}
        <div className="flex flex-wrap gap-2 border-b border-theme-color pb-2">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => {
                if (converting) return
                setActiveTab(tab.id)
                setFile(null)
                setResult(null)
                setOutputFormat(getDefaultOutputFormat(tab.id))
              }}
              disabled={converting}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
                activeTab === tab.id
                  ? 'bg-primary text-white'
                  : 'text-theme-secondary hover:bg-theme-hover'
              } disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              <tab.icon className="w-4 h-4" />
              {tab.label}
            </button>
          ))}
        </div>

        {/* File Upload Area */}
        <div
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
          onClick={() => fileInputRef.current?.click()}
          className="border-2 border-dashed border-theme-color rounded-xl p-8 text-center cursor-pointer hover:border-primary transition-colors"
        >
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={handleFileSelect}
            accept={activeTab === 'image' ? 'image/*' : activeTab === 'audio' ? 'audio/*' : 'video/*,.mkv,.mov,.webm'}
          />
          {!file ? (
            <div className="space-y-2">
              <Upload className="w-10 h-10 mx-auto text-theme-tertiary" />
              <p className="text-theme-secondary">{t('lab.converter.dropFile')}</p>
              <p className="text-xs text-theme-tertiary">{t('lab.converter.maxFileSize')}</p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-center gap-3">
                {activeTab === 'image' ? <FileImage className="w-6 h-6 text-blue-400" /> : activeTab === 'audio' ? <Music className="w-6 h-6 text-purple-400" /> : <Scissors className="w-6 h-6 text-green-400" />}
                <div className="text-left">
                  <p className="text-theme-on-surface text-sm font-medium truncate max-w-[300px]">{file.name}</p>
                  <p className="text-theme-tertiary text-xs">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); handleRemoveFile() }}
                  className="text-theme-tertiary hover:text-red-400 transition-colors"
                >x</button>
              </div>
              {!result && (
                <button
                  onClick={(e) => { e.stopPropagation(); handleConvert() }}
                  disabled={converting}
                  className="px-6 py-2 bg-primary text-white rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                  {converting ? (
                    <span className="flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />{t('lab.converter.converting')}</span>
                  ) : t('lab.converter.convert')}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Output Format + Options */}
        {file && (
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium text-theme-secondary mb-2 block">{t('lab.converter.outputFormat')}</label>
              {activeTab === 'image' ? (
                <select value={outputFormat} onChange={(e) => setOutputFormat(e.target.value)} className="w-full px-3 py-2 bg-theme-tertiary border border-theme-color rounded-lg text-theme-on-surface">
                  {formatOptions.image.map((opt) => (<option key={opt.value} value={opt.value}>{opt.label}</option>))}
                </select>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  {formatOptions[activeTab].map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => !converting && setOutputFormat(opt.value)}
                      disabled={converting}
                      className={`py-2 rounded-lg text-sm font-medium transition-colors ${outputFormat === opt.value ? 'bg-primary text-white' : 'bg-theme-tertiary text-theme-secondary hover:bg-theme-hover'} disabled:opacity-50 disabled:cursor-not-allowed`}
                    >{opt.label}</button>
                  ))}
                </div>
              )}
            </div>

            <div>
              <label className="text-sm font-medium text-theme-secondary mb-2 block">{t('lab.converter.exportName')}</label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={exportName}
                  onChange={(e) => setExportName(e.target.value)}
                  placeholder="converted"
                  className="flex-1 px-3 py-2 bg-theme-tertiary border border-theme-color rounded-lg text-theme-on-surface"
                />
                <span className="text-theme-tertiary text-sm shrink-0">.{outputFormat}</span>
              </div>
            </div>

            {activeTab === 'image' && (
              <div className="space-y-3">
                <div>
                  <label className="text-sm font-medium text-theme-secondary mb-2 block">{t('lab.converter.quality')}</label>
                  <input type="range" min="0.1" max="1" step="0.1" value={quality} onChange={(e) => setQuality(parseFloat(e.target.value))} className="w-full" />
                  <div className="flex justify-between text-xs text-theme-tertiary mt-1"><span>{Math.round(quality * 100)}%</span></div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-sm font-medium text-theme-secondary mb-1 block">{t('lab.converter.width')}</label>
                    <input type="number" value={scaleWidth} onChange={(e) => setScaleWidth(e.target.value)} placeholder="auto" className="w-full px-3 py-2 bg-theme-tertiary border border-theme-color rounded-lg text-theme-on-surface" />
                  </div>
                  <div>
                    <label className="text-sm font-medium text-theme-secondary mb-1 block">{t('lab.converter.height')}</label>
                    <input type="number" value={scaleHeight} onChange={(e) => setScaleHeight(e.target.value)} placeholder="auto" className="w-full px-3 py-2 bg-theme-tertiary border border-theme-color rounded-lg text-theme-on-surface" />
                  </div>
                </div>
              </div>
            )}

            {(activeTab === 'audio' || activeTab === 'extract') && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-sm font-medium text-theme-secondary mb-1 block">{t('lab.converter.bitrate')}</label>
                    <select value={audioBitrate} onChange={(e) => setAudioBitrate(e.target.value)} className="w-full px-3 py-2 bg-theme-tertiary border border-theme-color rounded-lg text-theme-on-surface">
                      <option value="128k">128 kbps</option>
                      <option value="192k">192 kbps</option>
                      <option value="256k">256 kbps</option>
                      <option value="320k">320 kbps</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-theme-secondary mb-1 block">{t('lab.converter.sampleRate')}</label>
                    <select value={audioSampleRate} onChange={(e) => setAudioSampleRate(e.target.value)} className="w-full px-3 py-2 bg-theme-tertiary border border-theme-color rounded-lg text-theme-on-surface">
                      <option value="44100">44100 Hz</option>
                      <option value="48000">48000 Hz</option>
                    </select>
                  </div>
                </div>

                {/* 音频专属：音量增益 + 裁剪 */}
                {activeTab === 'audio' && (
                  <div className="space-y-3">
                    {/* 音量增益 */}
                    <div>
                      <label className="text-sm font-medium text-theme-secondary mb-1 block">
                        {t('lab.converter.volumeGain')} ({volumeGain > 0 ? '+' : ''}{volumeGain} dB)
                      </label>
                      <div className="flex items-center gap-3">
                        <input
                          type="range" min="-20" max="20" step="1" value={volumeGain}
                          onChange={(e) => setVolumeGain(parseInt(e.target.value))}
                          className="flex-1"
                        />
                        <button
                          onClick={() => setVolumeGain(0)}
                          className="text-xs text-theme-tertiary hover:text-theme-on-surface px-2 py-1 rounded border border-theme-color"
                        >{t('lab.converter.reset')}</button>
                      </div>
                    </div>

                    {/* 音频裁剪 */}
                    <div>
                      <label className="text-sm font-medium text-theme-secondary mb-2 block">{t('lab.converter.trimAudio')}</label>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-xs text-theme-tertiary mb-1 block">{t('lab.converter.trimStart')}</label>
                          <input
                            type="text"
                            value={trimStart}
                            onChange={(e) => setTrimStart(e.target.value)}
                            placeholder="0:00"
                            className="w-full px-3 py-2 bg-theme-tertiary border border-theme-color rounded-lg text-theme-on-surface text-sm"
                          />
                        </div>
                        <div>
                          <label className="text-xs text-theme-tertiary mb-1 block">{t('lab.converter.trimEnd')}</label>
                          <input
                            type="text"
                            value={trimEnd}
                            onChange={(e) => setTrimEnd(e.target.value)}
                            placeholder="3:00"
                            className="w-full px-3 py-2 bg-theme-tertiary border border-theme-color rounded-lg text-theme-on-surface text-sm"
                          />
                        </div>
                      </div>
                      <p className="text-xs text-theme-tertiary mt-1">{t('lab.converter.trimHint')}</p>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Progress */}
        {converting && (
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-theme-secondary">{t('lab.converter.converting')}</span>
              <span className="text-theme-tertiary">{progress}%</span>
            </div>
            <div className="w-full bg-theme-tertiary rounded-full h-2">
              <div className="bg-primary h-2 rounded-full transition-all duration-300" style={{ width: `${progress}%` }} />
            </div>
            {logs.length > 0 && (
              <div className="bg-black/50 rounded-lg p-3 max-h-32 overflow-y-auto text-xs font-mono select-all">
                {logs.map((log, i) => (<div key={i} className="text-green-400 select-text">{log}</div>))}
              </div>
            )}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
            <p className="text-red-400 text-sm">{error}</p>
          </div>
        )}

        {/* Result */}
        {result && (
          <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4 flex items-center justify-between">
            <div className="flex items-center gap-2 truncate">
              <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />
              <span className="text-green-400 text-sm truncate">{getResultName()}</span>
              <span className="text-theme-tertiary text-xs">({(result.size / 1024 / 1024).toFixed(2)} MB)</span>
            </div>
            <button onClick={handleDownloadResult} className="flex items-center gap-1 px-4 py-2 bg-green-500 text-white rounded-lg hover:opacity-90 transition-opacity text-sm">
              <Download className="w-4 h-4" />{t('lab.converter.downloadResult')}
            </button>
          </div>
        )}
      </div>
    </LabLayout>
  )
}
