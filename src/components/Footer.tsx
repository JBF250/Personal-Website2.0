import { Link } from 'react-router-dom'
import { useI18n } from '@/context/I18nContext'
import { FULL_VERSION } from '@/generated-build'

export function Footer() {
  const { t } = useI18n()

  return (
    <footer className="bg-theme-secondary/80 backdrop-blur-xl border-t border-theme-color">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          <div>
            <div className="flex items-center gap-2 mb-4">
              <span className="font-display font-bold text-xl text-theme-primary">JBF个人站</span>
            </div>
          </div>
          
          <div>
            <ul className="space-y-2">
              <li>
                <a href="#about" className="text-theme-secondary hover:text-theme-primary transition-colors text-sm">
                  {t('nav.about')}
                </a>
              </li>
              <li>
                <a href="#games" className="text-theme-secondary hover:text-theme-primary transition-colors text-sm">
                  {t('nav.games')}
                </a>
              </li>
              <li>
                <a href="#software" className="text-theme-secondary hover:text-theme-primary transition-colors text-sm">
                  {t('nav.software')}
                </a>
              </li>
              <li>
                <Link to="/blog" className="text-theme-secondary hover:text-theme-primary transition-colors text-sm">
                  {t('nav.blog')}
                </Link>
              </li>
            </ul>
          </div>
          
          <div>
            <h3 className="text-theme-primary font-semibold mb-4">{t('contact.title')}</h3>
            <ul className="space-y-2">
              <li>
                <a 
                  href="https://github.com/JBF250" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="text-theme-secondary hover:text-theme-primary transition-colors text-sm flex items-center gap-2"
                >
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.7-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.578 9.578 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd"/>
                  </svg>
                  {t('contact.github')}
                </a>
              </li>
              <li>
                <a 
                  href="mailto:2686156845@qq.com" 
                  className="text-theme-secondary hover:text-theme-primary transition-colors text-sm"
                >
                  {t('contact.qqEmail')}
                </a>
              </li>
              <li>
                <a 
                  href="mailto:jiangbaofeng250@outlook.com" 
                  className="text-theme-secondary hover:text-theme-primary transition-colors text-sm"
                >
                  {t('contact.outlookEmail')}
                </a>
              </li>
              <li>
                <a 
                  href="https://space.bilibili.com/1016636140?spm_id_from=333.1007.0.0" 
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-theme-secondary hover:text-theme-primary transition-colors text-sm"
                >
                  {t('contact.bilibili')}
                </a>
              </li>
            </ul>
          </div>
        </div>
        
        <div className="border-t border-theme-color mt-8 pt-8 text-center">
          <p className="text-theme-secondary text-sm">
            {t('footer.copyright')}
            <span className="ml-2 opacity-70">· {FULL_VERSION}</span>
          </p>
        </div>
      </div>
    </footer>
  )
}