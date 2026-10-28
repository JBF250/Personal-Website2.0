import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App'
import { warmUpSupabase } from './lib/supabase'
import { preloadSite } from './lib/preload'

// 进站第一时间预热 Supabase，减少冷启动导致的博客加载失败与登录报错
warmUpSupabase()
// 首屏渲染完成后空闲时预载博客数据与工具代码
preloadSite()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)