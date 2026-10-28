import { useEffect, useRef, useState } from 'react'

// 图片加载:骨架图 + 真实下载进度环(流式读取字节计算百分比),完成后渐入;
// 已缓存图片走快速路径直接显示;fetch 失败则回退普通 img。
//
// 注意:在拿到地址之前不能渲染 <img>。空字符串的 src 会被浏览器视为无效资源并
// 立刻触发 onError,导致骨架/进度环被提前撤掉、只显示一个损坏占位。
export default function LazyImage({
  src,
  alt = '',
  wrapperClass = '',
  imgClass = '',
  minHeight = 140,
}: {
  src: string
  alt?: string
  wrapperClass?: string
  imgClass?: string
  minHeight?: number
}) {
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(false)
  // null 表示响应没有 Content-Length(无法算出百分比),此时用转动的环表示
  const [progress, setProgress] = useState<number | null>(0)
  const [source, setSource] = useState('')
  const urlRef = useRef('')

  useEffect(() => {
    setLoaded(false)
    setError(false)
    setProgress(0)
    setSource('')
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = ''
    }

    let cancelled = false
    let created = ''

    // 快速路径:浏览器缓存里已有完整图片 -> 直接用原地址,免去任何等待
    const probe = new Image()
    probe.src = src
    if (probe.complete && probe.naturalWidth > 0) {
      setSource(src)
      setProgress(100)
      setLoaded(true)
      return
    }

    // 主路径:fetch 流式读取,以字节比例给出真实进度
    const controller = new AbortController()
    fetch(src, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
        const total = Number(res.headers.get('Content-Length')) || 0
        // 拿不到总长就用不确定态(转圈),不要假装 0%
        if (!total) setProgress(null)
        const reader = res.body.getReader()
        const chunks: Uint8Array[] = []
        let received = 0
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
          received += value.length
          if (total > 0 && !cancelled) {
            setProgress(Math.min(99, Math.round((received / total) * 100)))
          }
        }
        if (cancelled) return null
        created = URL.createObjectURL(
          new Blob(chunks as BlobPart[], { type: mimeTypeOf(src, res.headers.get('Content-Type') || '') })
        )
        return created
      })
      .then((url) => {
        if (cancelled) return
        if (url) {
          urlRef.current = url
          // 只换地址,骨架留到 <img onLoad> 时再撤,避免出现"空档"
          setSource(url)
        } else {
          // fetch 无法流式(如外部跨域图) -> 回退普通 img
          setSource(src)
        }
      })
      .catch(() => {
        if (cancelled) return
        setSource(src)
      })

    return () => {
      cancelled = true
      controller.abort()
      if (created) URL.revokeObjectURL(created)
    }
  }, [src])

  const ringRadius = 21
  const ringLength = 2 * Math.PI * ringRadius
  const spinning = progress === null

  return (
    <div
      className={`relative overflow-hidden ${wrapperClass}`}
      style={{ minHeight: loaded ? undefined : minHeight }}
    >
      {!loaded && (
        <div className="absolute inset-0 rounded-xl flex items-center justify-center skeleton-shimmer">
          <svg
            className={`tilted-loader-ring ${spinning ? 'lazy-ring-rotate' : ''}`}
            viewBox="0 0 48 48"
            width="56"
            height="56"
          >
            <circle
              cx="24"
              cy="24"
              r={ringRadius}
              fill="none"
              stroke="rgba(255,255,255,0.18)"
              strokeWidth="4"
            />
            <circle
              cx="24"
              cy="24"
              r={ringRadius}
              fill="none"
              stroke="#22d3ee"
              strokeWidth="4"
              strokeLinecap="round"
              strokeDasharray={spinning ? `calc(0.45 * ${ringLength}) ${ringLength}` : ringLength}
              strokeDashoffset={
                spinning ? ringLength * 0.75 : ringLength * (1 - (progress ?? 0) / 100)
              }
              transform="rotate(-90 24 24)"
            />
          </svg>
          {!spinning && (
            <span className="tilted-loader-text">{Math.round(progress ?? 0)}%</span>
          )}
        </div>
      )}

      {source && (
        <img
          src={source}
          alt={alt}
          onLoad={() => {
            setProgress(100)
            setError(false)
            setLoaded(true)
          }}
          onError={() => {
            // Blob 解码失败时回退到原始地址再试一次，避免整张图停在损坏状态
            if (source !== src) {
              if (urlRef.current) {
                URL.revokeObjectURL(urlRef.current)
                urlRef.current = ''
              }
              setSource(src)
              return
            }
            setError(true)
            setLoaded(true)
          }}
          className={imgClass}
          style={{
            opacity: loaded ? (error ? 0.5 : 1) : 0,
            transition: 'opacity 0.6s ease'
          }}
        />
      )}
    </div>
  )
}

function mimeTypeOf(url: string, contentType: string): string {
  if (contentType.startsWith('image/')) return contentType
  const m = (url.split('?')[0].match(/\.(\w+)$/) || [])[1]
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    svg: 'image/svg+xml',
    bmp: 'image/bmp'
  }
  return (m && map[m]) || 'application/octet-stream'
}
