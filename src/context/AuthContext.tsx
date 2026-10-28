import { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY, type User } from '@/lib/supabase'

interface AuthContextType {
  user: User | null
  loading: boolean
  emailConfirmed: boolean
  login: (email: string, password: string) => Promise<void>
  register: (email: string, password: string, turnstileToken: string) => Promise<void>
  resendVerification: (email: string) => Promise<void>
  resetPassword: (email: string, turnstileToken: string) => Promise<void>
  updatePassword: (newPassword: string) => Promise<void>
  logout: () => Promise<void>
  updateUserSettings: (settings: Partial<User>) => Promise<void>
  uploadAvatar: (file: File) => Promise<string | null>
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [emailConfirmed, setEmailConfirmed] = useState(false)

  // 调用 Supabase Edge Function（公共函数，服务端完成 Turnstile 校验）
  const callEdgeFunction = async (name: string, body: Record<string, unknown>) => {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify(body),
    })

    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(data?.error || 'request_failed')
    }
    return data
  }

  const ensureUserProfile = async (authUser: any) => {
    console.log('ensureUserProfile called with authUser:', authUser?.id)
    
    const { data: profile, error: fetchError } = await supabase
      .from('users')
      .select('*')
      .eq('id', authUser.id)
      .maybeSingle()
    
    console.log('ensureUserProfile result:', { profile, fetchError })
    
    if (fetchError) {
      console.error('Failed to fetch user profile:', fetchError)
      return null
    }
    
    if (profile) {
      console.log('User profile found, avatar_url:', profile.avatar_url)
      return profile as User
    }

    // Only create new profile if user doesn't exist yet
    console.log('Creating new user profile for:', authUser.id)
    const { data: newProfile, error: insertError } = await supabase.from('users').insert({
      id: authUser.id,
      username: authUser.email || 'user',
      display_name: '游客',
      theme_color: '#8b5cf6',
      language: 'zh',
      custom_cursor: true,
      avatar_url: null,
      email: authUser.email || null
    }).select('*').single()
    
    if (insertError) {
      console.error('Failed to create user profile:', insertError)
      return null
    }
    
    console.log('New profile created:', newProfile)
    return newProfile as User || null
  }

  const getRedirectUrl = (path: string) => {
    const isLocalhost = window.location.hostname === 'localhost'
    return isLocalhost
      ? `http://localhost:5173${path}`
      : `https://gainian.de5.net${path}`
  }

  useEffect(() => {
    const fetchUser = async () => {
      const { data: { user: authUser } } = await supabase.auth.getUser()
      if (authUser) {
        setEmailConfirmed(!!authUser.email_confirmed_at)
        const profile = await ensureUserProfile(authUser)
        if (profile) {
          setUser(profile)
        }
      }
      setLoading(false)
    }
    fetchUser()

    const { data: listener } = supabase.auth.onAuthStateChange(async (_event, session) => {
      if (session?.user) {
        setEmailConfirmed(!!session.user.email_confirmed_at)
        const profile = await ensureUserProfile(session.user)
        if (profile) {
          setUser(profile)
        }
      } else {
        setUser(null)
        setEmailConfirmed(false)
      }
    })

    return () => listener?.subscription?.unsubscribe()
  }, [])

  const login = async (email: string, password: string) => {
    // Supabase 实例冷启动时登录请求可能长时间无响应，加超时避免按钮一直转圈
    const timeout = new Promise<never>((_, reject) =>
      window.setTimeout(() => reject(new Error('request-timeout')), 30000)
    )

    const { data, error } = await Promise.race([
      supabase.auth.signInWithPassword({ email, password }),
      timeout,
    ])
    
    if (error) throw error
    
    if (data.session?.user) {
      setEmailConfirmed(!!data.session.user.email_confirmed_at)
      const profile = await ensureUserProfile(data.session.user)
      if (profile) {
        setUser(profile)
      }
    }
  }

  const register = async (email: string, password: string, turnstileToken: string) => {
    // 先检查邮箱是否已注册（用户资料在首次登录时创建，已确认邮箱的用户此处可命中）
    const { data: existingUser } = await supabase
      .from('users')
      .select('email')
      .eq('email', email)
      .maybeSingle()
    
    if (existingUser) {
      throw new Error('EMAIL_ALREADY_REGISTERED')
    }

    try {
      await callEdgeFunction('auth-signup', { email, password, turnstileToken })
    } catch (err: any) {
      const code = err?.message
      if (code === 'email_already_registered') throw new Error('EMAIL_ALREADY_REGISTERED')
      if (code === 'turnstile_failed') throw new Error('TURNSTILE_FAILED')
      if (code === 'turnstile_not_configured') throw new Error('TURNSTILE_NOT_CONFIGURED')
      if (code === 'rate_limit') throw new Error('RATE_LIMIT')
      throw new Error('REGISTER_FAILED')
    }
  }

  const resendVerification = async (email: string) => {
    const { error } = await supabase.auth.resend({
      type: 'signup',
      email,
      options: {
        // PKCE 流程下对应邮件模板 {{ .RedirectTo }}，作为确认后的跳转目标（首页）
        emailRedirectTo: getRedirectUrl('/')
      }
    })
    if (error) throw error
  }

  const resetPassword = async (email: string, turnstileToken: string) => {
    try {
      await callEdgeFunction('auth-reset-password', { email, turnstileToken })
    } catch (err: any) {
      const code = err?.message
      if (code === 'turnstile_failed') throw new Error('TURNSTILE_FAILED')
      if (code === 'turnstile_not_configured') throw new Error('TURNSTILE_NOT_CONFIGURED')
      // 其它错误（邮箱不存在、限流等）按成功处理，防止邮箱枚举
    }
  }

  const updatePassword = async (newPassword: string) => {
    const { error } = await supabase.auth.updateUser({ password: newPassword })
    if (error) throw error
  }

  const logout = async () => {
    await supabase.auth.signOut()
    setUser(null)
    setEmailConfirmed(false)
  }

  const updateUserSettings = async (settings: Partial<User>) => {
    if (!user) return
    const { error } = await supabase
      .from('users')
      .update(settings)
      .eq('id', user.id)
    
    if (error) throw error
    
    setUser(prev => prev ? { ...prev, ...settings } : null)
  }

  const uploadAvatar = async (file: File) => {
    if (!user) return null
    
    const fileName = `avatars/${user.id}_${Date.now()}.${file.name.split('.').pop()}`
    const { error } = await supabase.storage
      .from('blog-images')
      .upload(fileName, file)
    
    if (error) {
      console.error('Upload failed:', error)
      return null
    }

    const { data: { publicUrl } } = supabase.storage
      .from('blog-images')
      .getPublicUrl(fileName)

    return publicUrl
  }

  return (
    <AuthContext.Provider value={{ user, loading, emailConfirmed, login, register, resendVerification, resetPassword, updatePassword, logout, updateUserSettings, uploadAvatar }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}