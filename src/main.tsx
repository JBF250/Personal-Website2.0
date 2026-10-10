import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App'
import { warmUpSupabase } from './lib/supabase'

// 进站第一时间预热 Supabase，减少冷启动导致的博客加载失败与登录报错
warmUpSupabase()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)