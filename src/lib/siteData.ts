import { supabase, type CommunityPost } from './supabase'

// 社区帖子缓存：进站预载与博客页共用同一份数据，
// 用户点进博客时可直接命中，不必再等一次（可能是冷启动的）网络请求。

const POSTS_TTL = 60_000
const REQUEST_TIMEOUT = 20_000

let postsCache: { data: CommunityPost[]; at: number } | null = null
let postsInFlight: Promise<CommunityPost[]> | null = null

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} 超时 (${ms / 1000}s)`)), ms)
    ),
  ])
}

export function invalidateCommunityPosts(): void {
  postsCache = null
}

/**
 * 拉取社区帖子。默认命中 60s 内的缓存；并发调用只会发出一个请求。
 * 失败时抛出错误，由调用方决定提示还是静默（预载场景静默）。
 */
export async function loadCommunityPosts(force = false): Promise<CommunityPost[]> {
  if (!force && postsCache && Date.now() - postsCache.at < POSTS_TTL) {
    return postsCache.data
  }
  if (postsInFlight) return postsInFlight

  postsInFlight = (async () => {
    const query = supabase
      .from('community_posts')
      .select('*')
      .order('created_at', { ascending: false })

    const { data, error } = await withTimeout(
      Promise.resolve(query),
      REQUEST_TIMEOUT,
      '加载博客'
    )
    if (error) throw error

    const list = (data ?? []) as CommunityPost[]
    postsCache = { data: list, at: Date.now() }
    return list
  })()

  try {
    return await postsInFlight
  } finally {
    postsInFlight = null
  }
}

export function hasCachedCommunityPosts(): boolean {
  return !!postsCache && Date.now() - postsCache.at < POSTS_TTL
}
