import { loadCommunityPosts } from './siteData'

// 进站预载：首屏渲染完成后，利用空闲时间提前拉取博客数据、预下载实验室工具的代码，
// 这样用户点进博客 / 实验室时基本可以立即打开。
// 所有失败都静默处理——预载只是优化，不影响正常使用。

let started = false

type Preloader = () => Promise<unknown>

// 只预载"工具"类页面，不含 3D / 游戏页（体积大且首屏用不到）
const TOOL_PRELOADS: Preloader[] = [
  () => import('@/pages/lab/LabHome'),
  () => import('@/pages/lab/QrCodePage'),
  () => import('@/pages/lab/ConverterPage'),
  () => import('@/pages/lab/GifToolPage'),
  () => import('@/pages/lab/KeyViewerPage'),
  () => import('@/pages/lab/IcoConverterPage'),
  () => import('@/pages/lab/AudioMetadataPage'),
  () => import('@/pages/lab/OcrPage'),
  () => import('@/pages/lab/RecorderPage'),
]

export function preloadSite(): void {
  if (started) return
  started = true

  // 用户开了省流模式就不要预载
  if ((navigator as any).connection?.saveData) return

  const run = async () => {
    // 先拉博客数据：用户最常访问，且慢网络下必须优先保证。
    // 等它结束（成功或失败）再预载工具代码，避免和博客请求抢带宽。
    try {
      await loadCommunityPosts()
    } catch {
      // 预载失败静默，用户进入博客页时还会重试
    }

    // 工具代码：串行加载，进一步降低对后续请求的影响
    for (const load of TOOL_PRELOADS) {
      try {
        await load()
      } catch {
        // 单个 chunk 失败不影响后续
      }
    }
  }

  const requestIdle = (window as any).requestIdleCallback
  if (typeof requestIdle === 'function') {
    requestIdle(run, { timeout: 4000 })
  } else {
    window.setTimeout(run, 2500)
  }
}
