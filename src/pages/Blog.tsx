import { useState, useEffect } from 'react'
import { Plus, Edit2, Trash2, Image, X, ArrowLeft, ThumbsUp, MessageCircle, User } from 'lucide-react'
import { useAuth } from '@/context/AuthContext'
import { useI18n } from '@/context/I18nContext'
import { supabase, type CommunityPost } from '@/lib/supabase'
import { loadCommunityPosts, invalidateCommunityPosts } from '@/lib/siteData'
import gainianPosts from '@/lib/gainianPosts'
import { useNavigate, useSearchParams } from 'react-router-dom'
import Avatar from '@/components/Avatar'
import BorderGlow from '@/components/BorderGlow'
import { BlogCardSkeleton } from '@/components/Skeleton'

export type CommunityPostWithAuthor = CommunityPost & {
  author?: { display_name: string; avatar_url: string | null; username: string } | null
}



export default function Blog() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [activeTab, setActiveTab] = useState<'community' | 'gainian'>(
    (searchParams.get('tab') as 'community' | 'gainian') || 'community'
  )
  const [posts, setPosts] = useState<CommunityPostWithAuthor[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [skeletonCount, setSkeletonCount] = useState(3)
  const [postStats, setPostStats] = useState<Record<string, { likes: number; comments: number }>>({})
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [showEditModal, setShowEditModal] = useState(false)
  const [editingPost, setEditingPost] = useState<CommunityPost | null>(null)
  const [newPost, setNewPost] = useState({ title: '', content: '' })
  const [uploadingImages, setUploadingImages] = useState(false)
  const [postImages, setPostImages] = useState<string[]>([])
  const { user, emailConfirmed } = useAuth()
  const { t, lang } = useI18n()
  const navigate = useNavigate()

  useEffect(() => {
    setSearchParams({ tab: activeTab })
  }, [activeTab, setSearchParams])

  useEffect(() => {
    if (activeTab === 'community') {
      fetchCommunityPosts()
    } else if (activeTab === 'gainian') {
      // 加载 gainian 帖子的统计数据
      const gainianIds = gainianPosts.map(p => p.id)
      if (gainianIds.length > 0) {
        loadPostStats(gainianIds, 'gainian')
      }
    }
  }, [activeTab, gainianPosts])

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' })
  }, [])

  const loadPostStats = async (postIds: string[], postType: string = 'community') => {
    const stats: Record<string, { likes: number; comments: number }> = {}
    
    // 初始化
    postIds.forEach(id => {
      stats[id] = { likes: 0, comments: 0 }
    })
    
    try {
      // 查询点赞数
      const { data: likesData } = await supabase
        .from('community_likes')
        .select('post_id')
        .eq('post_type', postType)
        .in('post_id', postIds)
      
      if (likesData) {
        likesData.forEach(like => {
          if (stats[like.post_id]) {
            stats[like.post_id].likes++
          }
        })
      }
      
      // 查询评论数
      const { data: commentsData } = await supabase
        .from('community_comments')
        .select('post_id')
        .eq('post_type', postType)
        .in('post_id', postIds)
      
      if (commentsData) {
        commentsData.forEach(comment => {
          if (stats[comment.post_id]) {
            stats[comment.post_id].comments++
          }
        })
      }
      
      setPostStats(stats)
    } catch (error) {
      console.error('Failed to load post stats:', error)
      setPostStats(stats)
    }
  }

  const fetchCommunityPosts = async (force = false) => {
    setIsLoading(true)
    setLoadError(false)
    try {
      // 进站预载已在后台发起，这里会复用同一请求 / 缓存，不重复拉取
      const data = await loadCommunityPosts(force)
      setSkeletonCount(Math.min(Math.max(data.length, 1), 12))

      const postsWithAuthor = data.map(post => ({
        ...post,
        author: {
          display_name: post.author_display_name || '匿名用户',
          avatar_url: post.author_avatar_url || null,
          username: post.author_display_name || 'anonymous'
        }
      }))

      setPosts(postsWithAuthor)
      if (postsWithAuthor.length > 0) {
        loadPostStats(postsWithAuthor.map(p => p.id))
      }
    } catch (error) {
      // 之前这里静默失败，页面会显示成"没有帖子"，让人误以为是空数据
      console.error('Failed to load community posts:', error)
      setPosts([])
      setLoadError(true)
    } finally {
      setIsLoading(false)
    }
  }

  const handleCreatePost = async () => {
    if (!newPost.title.trim() || !newPost.content.trim() || !user) return
    if (!emailConfirmed) return
    
    setUploadingImages(true)
    
    try {
      await supabase.from('community_posts').insert({
        user_id: user.id,
        title: newPost.title,
        content: newPost.content,
        images: postImages,
        author_display_name: user.display_name || user.username,
        author_avatar_url: user.avatar_url
      })
      
      setShowCreateModal(false)
      setNewPost({ title: '', content: '' })
      setPostImages([])
      invalidateCommunityPosts()
      fetchCommunityPosts(true)
    } catch (error) {
      console.error('Failed to create post:', error)
    } finally {
      setUploadingImages(false)
    }
  }

  const handleUpdatePost = async () => {
    if (!editingPost || !newPost.title.trim() || !newPost.content.trim() || !user) return
    if (!emailConfirmed) return
    
    try {
      await supabase
        .from('community_posts')
        .update({
          title: newPost.title,
          content: newPost.content,
          images: postImages,
          author_display_name: user.display_name || user.username,
          author_avatar_url: user.avatar_url
        })
        .eq('id', editingPost.id)
      
      setShowEditModal(false)
      setEditingPost(null)
      setNewPost({ title: '', content: '' })
      setPostImages([])
      invalidateCommunityPosts()
      fetchCommunityPosts(true)
    } catch (error) {
      console.error('Failed to update post:', error)
    }
  }

  const handleDeletePost = async (postId: string) => {
    if (!emailConfirmed) return
    if (!confirm(t('blog.confirmDelete'))) return
    
    try {
      await supabase.from('community_posts').delete().eq('id', postId)
      invalidateCommunityPosts()
      fetchCommunityPosts(true)
    } catch (error) {
      console.error('Failed to delete post:', error)
    }
  }

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || !user) return
    if (!emailConfirmed) return
    
    setUploadingImages(true)
    
    try {
      for (const file of Array.from(files)) {
        const fileName = `blog/${user.id}_${Date.now()}_${file.name}`
        const { error } = await supabase.storage
          .from('blog-images')
          .upload(fileName, file)
        
        if (!error) {
          const { data: { publicUrl } } = supabase.storage
            .from('blog-images')
            .getPublicUrl(fileName)
          
          setPostImages(prev => [...prev, publicUrl])
        }
      }
    } catch (error) {
      console.error('Failed to upload image:', error)
    } finally {
      setUploadingImages(false)
    }
  }

  const openEditModal = (post: CommunityPost) => {
    setEditingPost(post)
    setNewPost({ title: post.title, content: post.content })
    setPostImages(post.images || [])
    setShowEditModal(true)
  }

  return (
    <div className="min-h-screen bg-theme-primary">
      <section className="py-12 px-4">
        <div className="max-w-6xl mx-auto">
          <div className="flex items-center justify-between mb-8">
            <button
              onClick={() => navigate('/')}
              className="inline-flex items-center gap-2 text-theme-secondary hover:text-theme-primary transition-colors"
            >
              <ArrowLeft className="w-5 h-5" />
              {t('detail.back')}
            </button>
            <div className="text-center">
              <h1 className="font-display font-bold text-3xl md:text-4xl text-theme-primary mb-2">{t('blog.title')}</h1>
              <p className="text-theme-secondary text-sm md:text-base">{t('blog.community')} / {t('blog.gainian')}</p>
            </div>
            <div className="w-20 md:w-32" />
          </div>

          {/* Mobile navigation */}
          <div className="lg:hidden flex gap-3 mb-6">
            <BorderGlow
              backgroundColor="var(--bg-card)"
              glowColor="180 40 70"
              colors={['#22d3ee', '#94a3b8', '#a5b4fc']}
              borderRadius={12}
              glowRadius={14}
              glowIntensity={0.9}
              coneSpread={28}
              className="flex-1"
            >
              <button
                onClick={() => setActiveTab('community')}
                className={`w-full px-4 py-3 rounded-xl font-medium transition-all ${
                  activeTab === 'community'
                    ? 'bg-gradient-primary btn-primary-text'
                    : 'bg-transparent text-theme-secondary hover:text-primary'
                }`}
              >
                {t('blog.community')}
              </button>
            </BorderGlow>
            <BorderGlow
              backgroundColor="var(--bg-card)"
              glowColor="180 40 70"
              colors={['#22d3ee', '#94a3b8', '#a5b4fc']}
              borderRadius={12}
              glowRadius={14}
              glowIntensity={0.9}
              coneSpread={28}
              className="flex-1"
            >
              <button
                onClick={() => setActiveTab('gainian')}
                className={`w-full px-4 py-3 rounded-xl font-medium transition-all ${
                  activeTab === 'gainian'
                    ? 'bg-gradient-primary btn-primary-text'
                    : 'bg-transparent text-theme-secondary hover:text-primary'
                }`}
              >
                {t('blog.gainian')}
              </button>
            </BorderGlow>
          </div>

          {/* Desktop + Content: flex layout */}
          <div className="flex gap-8">
            {/* Desktop sidebar */}
            <div className="hidden lg:block w-56 flex-shrink-0">
              <div className="sticky top-24 space-y-2">
                <BorderGlow
                  backgroundColor="var(--bg-card)"
                  glowColor="180 40 70"
                  colors={['#22d3ee', '#94a3b8', '#a5b4fc']}
                  borderRadius={12}
                  glowRadius={14}
                  glowIntensity={0.9}
                  coneSpread={28}
                >
                  <button
                    onClick={() => setActiveTab('community')}
                    className={`w-full text-left px-4 py-3 rounded-xl font-medium transition-all ${
                      activeTab === 'community'
                        ? 'bg-gradient-primary btn-primary-text'
                        : 'bg-transparent text-theme-secondary hover:text-primary'
                    }`}
                  >
                    {t('blog.community')}
                  </button>
                </BorderGlow>
                <BorderGlow
                  backgroundColor="var(--bg-card)"
                  glowColor="180 40 70"
                  colors={['#22d3ee', '#94a3b8', '#a5b4fc']}
                  borderRadius={12}
                  glowRadius={14}
                  glowIntensity={0.9}
                  coneSpread={28}
                >
                  <button
                    onClick={() => setActiveTab('gainian')}
                    className={`w-full text-left px-4 py-3 rounded-xl font-medium transition-all ${
                      activeTab === 'gainian'
                        ? 'bg-gradient-primary btn-primary-text'
                        : 'bg-transparent text-theme-secondary hover:text-primary'
                    }`}
                  >
                    {t('blog.gainian')}
                  </button>
                </BorderGlow>
              </div>
            </div>

            {/* Content area */}
            <div className="flex-1">
              {activeTab === 'community' && (
                <>
                  {user && !emailConfirmed && (
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6 px-4 py-3 bg-amber-500/10 border border-amber-500/30 rounded-xl">
                      <p className="text-amber-600 dark:text-amber-400 text-sm">
                        {t('auth.emailConfirmRequired')}
                      </p>
                      <button
                        onClick={() => navigate('/register')}
                        className="shrink-0 px-4 py-2 bg-amber-500/20 text-amber-600 dark:text-amber-400 rounded-lg text-sm font-medium hover:bg-amber-500/30 transition-colors"
                      >
                        {t('auth.goVerify')}
                      </button>
                    </div>
                  )}
                  <div className="flex justify-end mb-6">
                    <button
                      onClick={() => {
                        if (!user) {
                          navigate('/login')
                          return
                        }
                        if (!emailConfirmed) return
                        setShowCreateModal(true)
                      }}
                      className="flex items-center gap-2 px-6 py-3 bg-gradient-primary btn-primary-text font-medium rounded-xl hover:opacity-90 transition-opacity"
                    >
                      <Plus className="w-5 h-5" />
                      {t('blog.newPost')}
                    </button>
                  </div>

                  {isLoading ? (
                    <div className="space-y-4">
                      {Array.from({ length: skeletonCount }).map((_, i) => (
                        <BlogCardSkeleton key={i} />
                      ))}
                    </div>
                  ) : loadError ? (
                    <div className="text-center py-12">
                      <p className="text-theme-secondary mb-4">{t('blog.loadFailed')}</p>
                      <button
                        onClick={() => fetchCommunityPosts(true)}
                        className="px-4 py-2 rounded-lg bg-primary text-white text-sm font-medium hover:opacity-90 transition-opacity"
                      >
                        {t('blog.retry')}
                      </button>
                    </div>
                  ) : posts.length === 0 ? (
                    <div className="text-center py-12">
                      <p className="text-theme-secondary">{t('blog.contentPlaceholder')}</p>
                    </div>
                  ) : (
                    <div className="space-y-4 animate-fade-in">
                      {posts.map((post) => (
                        <BorderGlow
                          key={post.id}
                          backgroundColor="var(--bg-card)"
                          glowColor="180 40 70"
                          colors={['#22d3ee', '#94a3b8', '#a5b4fc']}
                          borderRadius={16}
                          glowRadius={16}
                          glowIntensity={0.9}
                          coneSpread={28}
                        >
                          <div
                            onClick={() => navigate(`/blog/community/${post.id}`)}
                            className="p-5 cursor-pointer group"
                          >
                          <div className="flex justify-between items-start mb-3">
                            <h3 className="font-display font-bold text-lg text-theme-on-surface group-hover:text-primary transition-colors">
                              {post.title}
                            </h3>
                            {post.user_id === user?.id && (
                              <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                                <button
                                  onClick={() => openEditModal(post)}
                                  className="p-1.5 text-theme-secondary hover:text-theme-primary hover:bg-theme-hover rounded-lg transition-colors"
                                >
                                  <Edit2 className="w-4 h-4" />
                                </button>
                                <button
                                  onClick={() => handleDeletePost(post.id)}
                                  className="p-1.5 text-theme-secondary hover:text-red-400 hover:bg-theme-hover rounded-lg transition-colors"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              </div>
                            )}
                          </div>
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-4 text-theme-secondary text-sm">
                              <span className="flex items-center gap-2">
                                <Avatar
                                  src={post.author?.avatar_url}
                                  alt={post.author?.display_name || post.author?.username || '匿名用户'}
                                  size="sm"
                                />
                                {post.author?.display_name || post.author?.username || '匿名用户'}
                              </span>
                              <span>{new Date(post.created_at).toLocaleDateString()}</span>
                            </div>
                            <div className="flex items-center gap-4 text-theme-secondary text-sm">
                              <span className="flex items-center gap-1">
                                <ThumbsUp className="w-4 h-4" />
                                {postStats[post.id]?.likes || 0}
                              </span>
                              <span className="flex items-center gap-1">
                                <MessageCircle className="w-4 h-4" />
                                {postStats[post.id]?.comments || 0}
                              </span>
                            </div>
                          </div>
                          </div>
                        </BorderGlow>
                      ))}
                    </div>
                  )}
                </>
              )}

              {activeTab === 'gainian' && (
                <div className="space-y-4">
                  {gainianPosts.map((post) => (
                    <BorderGlow
                      key={post.id}
                      backgroundColor="var(--bg-card)"
                      glowColor="180 40 70"
                      colors={['#22d3ee', '#94a3b8', '#a5b4fc']}
                      borderRadius={16}
                      glowRadius={16}
                      glowIntensity={0.9}
                      coneSpread={28}
                    >
                      <div
                        onClick={() => navigate(`/blog/gainian/${post.id}`)}
                        className="p-5 cursor-pointer group"
                      >
                        <h3 className="font-display font-bold text-lg text-theme-on-surface mb-3 group-hover:text-primary transition-colors">
                          {post.title[lang]}
                        </h3>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-4 text-theme-secondary text-sm">
                            <span className="flex items-center gap-1">
                              <User className="w-4 h-4" />
                              概念1
                            </span>
                            <span>{post.date}</span>
                          </div>
                          <div className="flex items-center gap-4 text-theme-secondary text-sm">
                            <span className="flex items-center gap-1">
                              <ThumbsUp className="w-4 h-4" />
                              {postStats[post.id]?.likes || 0}
                            </span>
                            <span className="flex items-center gap-1">
                              <MessageCircle className="w-4 h-4" />
                              {postStats[post.id]?.comments || 0}
                            </span>
                          </div>
                        </div>
                      </div>
                    </BorderGlow>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {showCreateModal && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-theme-card rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto border border-theme-color">
            <div className="flex justify-between items-center p-6 border-b border-theme-color">
              <h2 className="font-display font-bold text-xl text-theme-on-surface">{t('blog.newPost')}</h2>
              <button
                onClick={() => { setShowCreateModal(false); setNewPost({ title: '', content: '' }); setPostImages([]) }}
                className="text-theme-secondary hover:text-theme-primary transition-colors"
              >
                <X className="w-6 h-6" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <input
                type="text"
                value={newPost.title}
                onChange={(e) => setNewPost({ ...newPost, title: e.target.value })}
                placeholder={t('blog.titlePlaceholder')}
                className="w-full px-4 py-3 bg-theme-tertiary border border-theme-color rounded-xl text-theme-on-surface placeholder-theme-secondary focus:outline-none focus:border-primary"
              />
              <textarea
                value={newPost.content}
                onChange={(e) => setNewPost({ ...newPost, content: e.target.value })}
                placeholder={t('blog.contentPlaceholder')}
                rows={8}
                className="w-full px-4 py-3 bg-theme-tertiary border border-theme-color rounded-xl text-theme-on-surface placeholder-theme-secondary focus:outline-none focus:border-primary resize-none"
              />
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 px-4 py-2 bg-theme-tertiary text-theme-on-surface rounded-lg cursor-pointer hover:bg-theme-hover transition-colors">
                  <Image className="w-5 h-5" />
                  <span>上传图片</span>
                  <input
                    type="file"
                    multiple
                    accept="image/*"
                    onChange={handleImageUpload}
                    className="hidden"
                  />
                </label>
                {postImages.length > 0 && (
                  <span className="text-theme-secondary text-sm">{postImages.length} 张图片</span>
                )}
              </div>
              {postImages.map((img, index) => (
                <div key={index} className="relative inline-block mr-2">
                  <img 
                    src={img} 
                    alt={`Uploaded ${index}`} 
                    crossOrigin="anonymous"
                    className="w-20 h-20 object-cover rounded-lg"
                    onError={(e) => {
                      console.warn('Blog preview image failed to load:', img)
                      ;(e.target as HTMLImageElement).style.opacity = '0.5'
                    }}
                  />
                  <button
                    onClick={() => setPostImages(prev => prev.filter((_, i) => i !== index))}
                    className="absolute -top-2 -right-2 w-6 h-6 bg-red-500 rounded-full flex items-center justify-center text-white text-xs"
                  >
                    X
                  </button>
                </div>
              ))}
            </div>
            <div className="p-6 border-t border-theme-color flex justify-end gap-4">
              <button
                onClick={() => { setShowCreateModal(false); setNewPost({ title: '', content: '' }); setPostImages([]) }}
                className="px-6 py-3 bg-theme-tertiary text-theme-on-surface rounded-xl hover:bg-theme-hover transition-colors"
              >
                {t('blog.cancel')}
              </button>
              <button
                onClick={handleCreatePost}
                disabled={uploadingImages || !newPost.title.trim() || !newPost.content.trim()}
                className="px-6 py-3 bg-gradient-primary btn-primary-text rounded-xl hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {uploadingImages ? t('blog.submit') + '...' : t('blog.submit')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showEditModal && editingPost && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-theme-card rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto border border-theme-color">
            <div className="flex justify-between items-center p-6 border-b border-theme-color">
              <h2 className="font-display font-bold text-xl text-theme-on-surface">{t('blog.edit')}</h2>
              <button
                onClick={() => { setShowEditModal(false); setEditingPost(null); setNewPost({ title: '', content: '' }); setPostImages([]) }}
                className="text-theme-secondary hover:text-theme-primary transition-colors"
              >
                <X className="w-6 h-6" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <input
                type="text"
                value={newPost.title}
                onChange={(e) => setNewPost({ ...newPost, title: e.target.value })}
                placeholder={t('blog.titlePlaceholder')}
                className="w-full px-4 py-3 bg-theme-tertiary border border-theme-color rounded-xl text-theme-on-surface placeholder-theme-secondary focus:outline-none focus:border-primary"
              />
              <textarea
                value={newPost.content}
                onChange={(e) => setNewPost({ ...newPost, content: e.target.value })}
                placeholder={t('blog.contentPlaceholder')}
                rows={8}
                className="w-full px-4 py-3 bg-theme-tertiary border border-theme-color rounded-xl text-theme-on-surface placeholder-theme-secondary focus:outline-none focus:border-primary resize-none"
              />
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 px-4 py-2 bg-theme-tertiary text-theme-on-surface rounded-lg cursor-pointer hover:bg-theme-hover transition-colors">
                  <Image className="w-5 h-5" />
                  <span>上传图片</span>
                  <input
                    type="file"
                    multiple
                    accept="image/*"
                    onChange={handleImageUpload}
                    className="hidden"
                  />
                </label>
              </div>
              {postImages.map((img, index) => (
                <div key={index} className="relative inline-block mr-2">
                  <img 
                    src={img} 
                    alt={`Uploaded ${index}`} 
                    crossOrigin="anonymous"
                    className="w-20 h-20 object-cover rounded-lg"
                    onError={(e) => {
                      console.warn('Blog preview image failed to load:', img)
                      ;(e.target as HTMLImageElement).style.opacity = '0.5'
                    }}
                  />
                  <button
                    onClick={() => setPostImages(prev => prev.filter((_, i) => i !== index))}
                    className="absolute -top-2 -right-2 w-6 h-6 bg-red-500 rounded-full flex items-center justify-center text-white text-xs"
                  >
                    X
                  </button>
                </div>
              ))}
            </div>
            <div className="p-6 border-t border-theme-color flex justify-end gap-4">
              <button
                onClick={() => { setShowEditModal(false); setEditingPost(null); setNewPost({ title: '', content: '' }); setPostImages([]) }}
                className="px-6 py-3 bg-theme-tertiary text-theme-on-surface rounded-xl hover:bg-theme-hover transition-colors"
              >
                {t('blog.cancel')}
              </button>
              <button
                onClick={handleUpdatePost}
                disabled={!newPost.title.trim() || !newPost.content.trim()}
                className="px-6 py-3 bg-gradient-primary btn-primary-text rounded-xl hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {t('blog.update')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}