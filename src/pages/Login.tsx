import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, Eye, EyeOff } from 'lucide-react'
import { useAuth } from '@/context/AuthContext'
import { useI18n } from '@/context/I18nContext'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const { login } = useAuth()
  const { t } = useI18n()
  const navigate = useNavigate()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      await login(email, password)
      navigate('/')
    } catch (err: any) {
      const errMsg = (err?.message || '').toLowerCase()
      if (errMsg.includes('email not confirmed')) {
        setError(t('auth.emailNotVerified'))
      } else if (errMsg.includes('rate limit')) {
        setError(t('auth.rateLimit'))
      } else if (errMsg.includes('invalid login credentials') || errMsg.includes('invalid_grant')) {
        // 只有明确的凭据错误才是账号或密码不对
        setError(t('auth.loginFailed'))
      } else {
        // 网络超时、实例冷启动等异常不能误报成密码错误，否则用户会反复重输密码
        setError(t('auth.networkError'))
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-dark-900 px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <Link 
            to="/" 
            className="inline-flex items-center gap-2 mb-4 group"
          >
            <span className="font-display font-bold text-2xl text-white">JBF个人站</span>
          </Link>
          <h1 className="text-2xl font-display font-bold text-white mb-2">
            {t('auth.login')}
          </h1>
          <p className="text-gray-500">
            {t('auth.hasAccount')}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-300">
              {t('auth.email')}
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-4 py-3 bg-dark-800 border border-dark-600 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:border-primary transition-colors"
              placeholder="email@example.com"
              required
            />
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-300">
              {t('auth.password')}
            </label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-3 pr-12 bg-dark-800 border border-dark-600 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:border-primary transition-colors"
                placeholder={t('auth.password')}
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white transition-colors"
              >
                {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
              </button>
            </div>
          </div>

          {error && (
            <p className="text-red-400 text-sm">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 bg-gradient-primary text-white font-medium rounded-xl hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {loading ? t('auth.loggingIn') : t('auth.login')}
          </button>
        </form>

        <div className="mt-6 text-center space-y-3">
          <div>
            <Link 
              to="/forgot-password" 
              className="text-gray-400 hover:text-primary text-sm"
            >
              {t('auth.forgotPassword')}
            </Link>
          </div>
          <p className="text-gray-500 text-sm">
            {t('auth.noAccount')}
            <Link 
              to="/register" 
              className="text-primary hover:underline ml-1"
            >
              {t('auth.register')}
            </Link>
          </p>
        </div>

        <div className="mt-8">
          <button
            onClick={() => navigate('/')}
            className="flex items-center gap-2 text-gray-500 hover:text-white transition-colors text-sm"
          >
            <ArrowLeft className="w-4 h-4" />
            {t('auth.backHome')}
          </button>
        </div>
      </div>
    </div>
  )
}