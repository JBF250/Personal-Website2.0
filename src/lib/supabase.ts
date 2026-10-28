import { createClient } from '@supabase/supabase-js'

export const SUPABASE_URL = 'https://noiebpjyskscjtmdytxj.supabase.co'
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5vaWVicGp5c2tzY2p0bWR5dHhqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ4NjY2MzEsImV4cCI6MjEwMDQ0MjYzMX0.1KQOc02ySuxi-k845kbplnXyXndrlH6hxz58sFFb_Rs'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    // PKCE 流程：邮件使用 token_hash 链接跳转到本站页面，
    // 用户手动点击确认按钮后调用 verifyOtp 兑换会话，避免邮箱安全自检预先消耗一次性 token。
    flowType: 'pkce',
    detectSessionInUrl: true,
  },
})

/**
 * 冷启动预热。
 *
 * Supabase 免费版实例空闲一段时间后实例会休眠，此时首批请求容易超时失败，
 * 表现为博客加载不出来、登录报错，过几分钟才恢复。
 * 在进入网站的第一时间发一个轻量的真实查询，可以提前唤醒实例并建立连接；
 * 这个请求同时会产出数据库活动记录，避免项目因长期无活动被自动暂停。
 */
let warmUpStarted = false

export function warmUpSupabase(): void {
  if (warmUpStarted) return
  warmUpStarted = true

  const ping = async (attempt: number): Promise<void> => {
    try {
      // 冷启动时请求可能长时间无响应，加超时才能进入下一轮重试
      const result = await Promise.race([
        supabase.from('game_leaderboard').select('id').limit(1),
        new Promise<never>((_, reject) =>
          window.setTimeout(() => reject(new Error('warm-up timeout')), 15000)
        ),
      ])
      if (result.error) throw result.error
    } catch {
      // 冷启动可能持续数十秒，失败后退避重试，覆盖更长的唤醒时间
      if (attempt < 2) {
        window.setTimeout(() => {
          void ping(attempt + 1)
        }, 2500)
      }
    }
  }

  void ping(0)
}

export type User = {
  id: string
  username: string
  display_name: string
  avatar_url: string | null
  theme_color: string
  language: string
  custom_cursor: boolean
}

export type CommunityPost = {
  id: string
  user_id: string
  title: string
  content: string
  images: string[]
  author_display_name: string
  author_avatar_url: string | null
  created_at: string
  updated_at: string
}
