/**
 * 工蜂 · 小红书选品采集 —— Client 半（浏览器里的工作台面板）
 *
 * 纯 JS、无构建：客户改完这个文件，刷新 DSH 页面即可生效（Host 半的 index.js 改完要重载插件）。
 * 数据全部走 Host 的 /plugins/xhs-workbench/* 同源路由，浏览器里没有工蜂钥匙。
 *
 * 结构：
 *   MODULES      —— 12 个采集模块，加模块就在这里加一行
 *   Workbench    —— 主面板（采集 / 任务 / 设备）
 *   ResultDialog —— 结果抽屉（商品 / 笔记 / 评论 / 店铺 / 博主主页 + 原始 JSON）
 */

window.__ModuleLoader__.load({
  id: '@workerbee/dsh-xhs-workbench',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const API = '/plugins/xhs-workbench'
    const CSRF_HEADER = { 'x-xhs-workbench': '1' }

    /* ---------------- 模块表：一个模块 = 一个 task_type ---------------- */

    const MODULES = [
      { type: 'keyword', group: '商品', title: '关键词搜商品', desc: '按销量搜商品，采标题/价格/已售/店铺', input: 'keyword', placeholder: '输入关键词，如：陶瓷马克杯' },
      { type: 'goods_link', group: '商品', title: '单个商品采集', desc: '直接采一个商品详情页', input: 'link', placeholder: '粘贴商品链接 xhslink.com/m/…', fixed: 1 },
      { type: 'shop_info', group: '商品', title: '店铺信息采集', desc: '评分/粉丝/已售/好评率；店铺或商品链接都行', input: 'link', placeholder: '粘贴店铺链接，商品链接也行', fixed: 1 },
      { type: 'shop_link', group: '商品', title: '店铺所有商品', desc: '进店把整店商品捞下来', input: 'link', placeholder: '粘贴店铺链接 …/shop/…' },
      { type: 'goods_comments', group: '商品', title: '商品评价采集', desc: '评价者/正文/规格/日期/图数/点赞', input: 'link', placeholder: '粘贴商品链接 xhslink.com/m/…', fixed: 1 },
      { type: 'creator_discovery', group: '笔记', title: '关键词搜博主', desc: '搜笔记扒作者 UID，连环找同类博主', input: 'keyword', placeholder: '输入关键词，如：陶瓷马克杯' },
      { type: 'note_link', group: '笔记', title: '单条笔记采集', desc: '正文/赞藏评/封面图/挂车商品', input: 'link', placeholder: '粘贴笔记链接，一行一条', fixed: 1 },
      { type: 'creator_profile', group: '笔记', title: '博主主页信息', desc: '昵称/小红书号/简介/粉丝/关注', input: 'link', placeholder: '粘贴主页 …/user/profile/…', fixed: 1 },
      { type: 'creator_notes', group: '笔记', title: '博主所有笔记', desc: '把这个博主的笔记逐条采下来', input: 'link', placeholder: '粘贴主页 …/user/profile/…' },
      { type: 'note_comments', group: '笔记', title: '笔记评论采集', desc: '评论者/内容/点赞/时间地点', input: 'link', placeholder: '粘贴笔记链接 xhslink.com/o/…', fixed: 1 },
      { type: 'matrix_creator_discovery', group: '进阶', title: '矩阵号猎手', desc: '按关键词扒挂车商品，比对目标店铺，揪出矩阵号', input: 'keyword', placeholder: '关键词（另需目标商家）', needsTarget: true },
      { type: 'root_keyword_search', group: '进阶', title: 'Root 关键词搜索', desc: '截获官方搜索接口，直接产出博主 UID 名单', input: 'keyword', placeholder: '输入关键词（需 Root 手机）' },
    ]

    const MODULE_BY_TYPE = Object.fromEntries(MODULES.map((item) => [item.type, item]))
    const MODULE_GROUPS = ['商品', '笔记', '进阶']

    const STATUS_LABELS = {
      pending: '排队中',
      running: '采集中',
      completed: '已完成',
      partial: '部分完成',
      failed: '失败',
      cancelled: '已取消',
    }

    /* ---------------- 小工具 ---------------- */

    async function api(path, options = {}) {
      const { method = 'GET', body } = options
      const response = await fetch(API + path, {
        method,
        headers: {
          ...CSRF_HEADER,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok || payload?.ok === false) {
        const message = payload?.error?.message || `请求失败（${response.status}）`
        const error = new Error(message)
        error.code = payload?.error?.code || `HTTP_${response.status}`
        throw error
      }
      return payload
    }

    function formatTime(ts) {
      if (!ts) return '—'
      const date = new Date(ts * 1000)
      const pad = (value) => String(value).padStart(2, '0')
      return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function shortHost(base) {
      try {
        return new URL(base).host
      } catch {
        return base || ''
      }
    }

    function textOf(value) {
      if (value === null || value === undefined) return ''
      if (typeof value === 'string') return value
      if (typeof value === 'number') return String(value)
      return ''
    }

    function mediaUrl(url) {
      if (!url) return ''
      return `${API}/media?url=${encodeURIComponent(url)}`
    }

    /* ---------------- 数字/金额解析（和桌面工作台同口径） ---------------- */

    function numberLike(value) {
      if (typeof value === 'number') return Number.isFinite(value) ? value : 0
      const text = String(value === null || value === undefined ? '' : value).replace(/,/g, '')
      const match = text.match(/([0-9]+(?:\.[0-9]+)?)/)
      if (!match) return 0
      let num = Number.parseFloat(match[1])
      if (/亿/.test(text)) num *= 100000000
      else if (/万/.test(text)) num *= 10000
      return Number.isFinite(num) ? num : 0
    }

    function cartCount(item) {
      const text = (item?.hit_tags || []).join(' ')
      const match =
        text.match(/24\s*(?:小时|h|H)[^0-9]{0,12}([0-9][0-9,.]*)\+?\s*人?加购/) ||
        text.match(/([0-9][0-9,.]*)\+?\s*人?加购/)
      return match ? numberLike(match[1]) : 0
    }

    function bizOf(item) {
      const price = numberLike(item?.price)
      const sold = numberLike(item?.sold_count || item?.sold_text)
      const cart = cartCount(item || {})
      return { price, sold, cart, daily: cart * price, total: sold * price }
    }

    function compact(value) {
      const num = numberLike(value)
      if (!num) return '—'
      if (num >= 100000000) return `${(num / 100000000).toFixed(1).replace(/\.0$/, '')}亿`
      if (num >= 10000) return `${(num / 10000).toFixed(num >= 100000 ? 0 : 1).replace(/\.0$/, '')}万`
      return String(Math.round(num))
    }

    function money(value) {
      const num = numberLike(value)
      if (!num) return '—'
      return compact(num)
    }

    function priceText(value) {
      if (value === null || value === undefined || value === '') return '—'
      const num = Number(value)
      if (!Number.isFinite(num)) return String(value)
      return num.toFixed(num % 1 === 0 ? 0 : 2)
    }

    function soldText(item) {
      const text = String(item?.sold_text || '').replace(/已售/g, '').trim()
      if (text) return text
      return item?.sold_count ? compact(item.sold_count) : '—'
    }

    function dateTime(ts) {
      if (!ts) return '—'
      const date = new Date(ts * 1000)
      const pad = (value) => String(value).padStart(2, '0')
      return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /* ---------------- 基础组件 ---------------- */

    function Styles() {
      return h('style', null, CSS)
    }

    function StatusBadge({ status }) {
      const label = STATUS_LABELS[status] || status || '未知'
      return h('span', { className: `xwb-badge xwb-badge-${status || 'unknown'}` }, label)
    }

    function Field({ label, children }) {
      return h('label', { className: 'xwb-field' }, h('span', { className: 'xwb-field-label' }, label), children)
    }

    function Thumb({ url, alt }) {
      const [failed, setFailed] = useState(false)
      if (!url || failed) {
        return h('div', { className: 'xwb-thumb xwb-thumb-empty', 'aria-hidden': true }, '无图')
      }
      return h('img', {
        className: 'xwb-thumb',
        src: mediaUrl(url),
        alt: alt || '',
        loading: 'lazy',
        onError: () => setFailed(true),
      })
    }

    function KeyValue({ data }) {
      const entries = Object.entries(data || {}).filter(
        ([, value]) => value !== null && value !== undefined && value !== '' && typeof value !== 'object',
      )
      if (!entries.length) return h('div', { className: 'xwb-muted' }, '暂无字段')
      return h(
        'div',
        { className: 'xwb-kv' },
        entries.map(([key, value]) => h('div', { className: 'xwb-kv-row', key }, h('span', { className: 'xwb-kv-key' }, key), h('span', { className: 'xwb-kv-value' }, String(value)))),
      )
    }

    /* ---------------- 结果渲染 ---------------- */

    function ProductCard({ record }) {
      const product = record.product || {}
      const seller = record.seller || {}
      const media = record.media || {}
      const cover = (media.main_images || [])[0] || ''
      const tags = (product.tags && product.tags.selling_points) || []
      return h(
        'article',
        { className: 'xwb-card xwb-product' },
        h(Thumb, { url: cover, alt: product.title }),
        h(
          'div',
          { className: 'xwb-product-body' },
          h('div', { className: 'xwb-product-title' }, textOf(product.title) || record.item_id || '未命名商品'),
          h(
            'div',
            { className: 'xwb-product-meta' },
            product.price !== null && product.price !== undefined ? h('span', { className: 'xwb-price' }, `¥${product.price}`) : null,
            product.original_price ? h('span', { className: 'xwb-muted xwb-strike' }, `¥${product.original_price}`) : null,
            product.sold_text || product.sold_count ? h('span', { className: 'xwb-muted' }, `已售 ${product.sold_text || product.sold_count}`) : null,
          ),
          seller.name
            ? h(
                'div',
                { className: 'xwb-seller' },
                h('span', null, seller.name),
                seller.score_text || seller.score ? h('span', { className: 'xwb-muted' }, `评分 ${seller.score_text || seller.score}`) : null,
                seller.fans_amount || seller.fans_count ? h('span', { className: 'xwb-muted' }, `粉丝 ${seller.fans_amount || seller.fans_count}`) : null,
              )
            : null,
          tags.length ? h('div', { className: 'xwb-tags' }, tags.slice(0, 6).map((tag, index) => h('span', { className: 'xwb-tag', key: `${tag}-${index}` }, tag))) : null,
          record.url ? h('a', { className: 'xwb-link', href: record.url, target: '_blank', rel: 'noreferrer' }, '打开商品页') : null,
        ),
      )
    }

    function NoteCard({ note }) {
      return h(
        'article',
        { className: 'xwb-card xwb-note' },
        h(Thumb, { url: note.cover_image_url, alt: note.title }),
        h(
          'div',
          { className: 'xwb-product-body' },
          h('div', { className: 'xwb-product-title' }, textOf(note.title) || '无标题笔记'),
          h('div', { className: 'xwb-product-meta' }, h('span', null, note.author || '未知作者'), note.publish_time_text ? h('span', { className: 'xwb-muted' }, note.publish_time_text) : null),
          h(
            'div',
            { className: 'xwb-product-meta' },
            note.like_text ? h('span', { className: 'xwb-muted' }, `赞 ${note.like_text}`) : null,
            note.collect_text ? h('span', { className: 'xwb-muted' }, `藏 ${note.collect_text}`) : null,
            note.comment_text ? h('span', { className: 'xwb-muted' }, `评 ${note.comment_text}`) : null,
          ),
          note.body_text ? h('p', { className: 'xwb-body-text' }, String(note.body_text).slice(0, 120)) : null,
          note.note_url ? h('a', { className: 'xwb-link', href: note.note_url, target: '_blank', rel: 'noreferrer' }, '打开笔记') : null,
        ),
      )
    }

    function CommentRow({ comment, index }) {
      return h(
        'div',
        { className: 'xwb-comment', key: String(comment.comment_id || index) },
        h('div', { className: 'xwb-comment-head' }, h('b', null, comment.commenter || '匿名'), comment.comment_date ? h('span', { className: 'xwb-muted' }, comment.comment_date) : null),
        h('div', { className: 'xwb-comment-body' }, comment.content || ''),
        h(
          'div',
          { className: 'xwb-comment-foot' },
          comment.sku ? h('span', { className: 'xwb-muted' }, comment.sku) : null,
          comment.like_text ? h('span', { className: 'xwb-muted' }, `赞 ${comment.like_text}`) : null,
        ),
      )
    }

    function ResultBody({ result, raw }) {
      if (!result) return h('div', { className: 'xwb-empty' }, '还没有结果')
      if (raw) {
        return h('pre', { className: 'xwb-json' }, JSON.stringify(result, null, 2))
      }
      const blocks = []

      if (Array.isArray(result.records) && result.records.length) {
        blocks.push(h('h4', { className: 'xwb-section-title', key: 'records' }, `商品（${result.records.length}）`))
        blocks.push(h('div', { className: 'xwb-list', key: 'records-list' }, result.records.map((record, index) => h(ProductCard, { record, key: `${record.item_id}-${index}` }))))
      }

      if (Array.isArray(result.notes) && result.notes.length) {
        blocks.push(h('h4', { className: 'xwb-section-title', key: 'notes' }, `笔记（${result.notes.length}）`))
        blocks.push(h('div', { className: 'xwb-list', key: 'notes-list' }, result.notes.map((note, index) => h(NoteCard, { note, key: `${note.note_id}-${index}` }))))
      }

      if (Array.isArray(result.comments) && result.comments.length) {
        blocks.push(h('h4', { className: 'xwb-section-title', key: 'comments' }, `评论（${result.comments.length}）`))
        blocks.push(h('div', { className: 'xwb-comments', key: 'comments-list' }, result.comments.map((comment, index) => h(CommentRow, { comment, index, key: index }))))
      }

      if (result.shop_info && Object.keys(result.shop_info).length) {
        blocks.push(h('h4', { className: 'xwb-section-title', key: 'shop' }, '店铺档案'))
        blocks.push(h(KeyValue, { data: result.shop_info, key: 'shop-kv' }))
      }

      if (result.creator_profile && Object.keys(result.creator_profile).length) {
        blocks.push(h('h4', { className: 'xwb-section-title', key: 'creator' }, '博主主页'))
        blocks.push(h(KeyValue, { data: result.creator_profile, key: 'creator-kv' }))
      }

      if (!blocks.length) {
        blocks.push(h('div', { className: 'xwb-empty', key: 'empty' }, '任务还没有产出结果。采集中请稍后再看。'))
      }

      return h('div', { className: 'xwb-result' }, blocks)
    }

    function ResultDialog({ task, onClose, onRefresh }) {
      const [result, setResult] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState('')
      const [raw, setRaw] = useState(false)

      const load = useCallback(async () => {
        setLoading(true)
        setError('')
        try {
          const payload = await api(`/result?id=${Number(task.task_id)}`)
          setResult(payload)
        } catch (err) {
          setError(err.message || String(err))
        } finally {
          setLoading(false)
        }
      }, [task.task_id])

      useEffect(() => {
        load()
      }, [load])

      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])

      const moduleInfo = MODULE_BY_TYPE[task.task_type] || {}
      return h(
        'div',
        { className: 'xwb-modal', role: 'dialog', 'aria-modal': 'true' },
        h('div', { className: 'xwb-modal-backdrop', onClick: onClose }),
        h(
          'div',
          { className: 'xwb-modal-panel' },
          h(
            'header',
            { className: 'xwb-modal-head' },
            h(
              'div',
              { className: 'xwb-modal-title' },
              h('div', { className: 'xwb-modal-name' }, `#${task.task_id} ${moduleInfo.title || task.task_type || ''}`),
              h('div', { className: 'xwb-muted xwb-ellipsis' }, textOf(task.input) || '—'),
            ),
            h(
              'div',
              { className: 'xwb-modal-actions' },
              h(StatusBadge, { status: task.status }),
              h('button', { className: 'xwb-btn', type: 'button', onClick: () => setRaw((value) => !value) }, raw ? '看结果' : '原始 JSON'),
              h('button', { className: 'xwb-btn', type: 'button', onClick: load }, '刷新'),
              h('button', { className: 'xwb-btn', type: 'button', onClick: onClose }, '关闭'),
            ),
          ),
          h(
            'div',
            { className: 'xwb-modal-body' },
            loading ? h('div', { className: 'xwb-empty' }, '正在取结果…') : null,
            error ? h('div', { className: 'xwb-alert' }, error) : null,
            !loading && !error ? h(ResultBody, { result, raw }) : null,
          ),
          h(
            'footer',
            { className: 'xwb-modal-foot' },
            h(
              'span',
              { className: 'xwb-muted' },
              result?.stats ? `采集 ${result.stats.collected_count} · 解析 ${result.stats.parsed_count}` : '',
              result?.completion_reason ? ` · ${result.completion_reason}` : '',
            ),
            h('button', { className: 'xwb-btn', type: 'button', onClick: () => { onRefresh?.(); load() } }, '重新读取'),
          ),
        ),
      )
    }

    /* ---------------- 主面板 ---------------- */

    function Workbench() {
      const [status, setStatus] = useState(null)
      const [tasks, setTasks] = useState([])
      const [tab, setTab] = useState('pools')
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [selected, setSelected] = useState(null)

      const [moduleType, setModuleType] = useState('keyword')
      const [input, setInput] = useState('')
      const [count, setCount] = useState(20)
      const [target, setTarget] = useState('')
      const [device, setDevice] = useState('')
      const [submitting, setSubmitting] = useState(false)
      const [coreBusy, setCoreBusy] = useState(false)

      const alive = useRef(true)
      const busy = useRef(false)

      const refresh = useCallback(async () => {
        if (busy.current) return
        busy.current = true
        try {
          const [statusPayload, tasksPayload] = await Promise.all([
            api('/status'),
            api('/tasks?limit=30').catch(() => ({ tasks: [] })),
          ])
          if (!alive.current) return
          setStatus(statusPayload)
          setTasks(Array.isArray(tasksPayload.tasks) ? tasksPayload.tasks : [])
          setError('')
        } catch (err) {
          if (!alive.current) return
          setError(err.message || String(err))
        } finally {
          busy.current = false
        }
      }, [])

      useEffect(() => {
        alive.current = true
        refresh()
        const timer = setInterval(refresh, 5000)
        return () => {
          alive.current = false
          clearInterval(timer)
        }
      }, [refresh])

      const moduleInfo = MODULE_BY_TYPE[moduleType] || MODULES[0]
      const connected = Boolean(status?.connected)
      const devices = status?.devices || []

      const counts = useMemo(() => {
        const result = { running: 0, pending: 0, completed: 0 }
        for (const task of tasks) {
          if (task.status === 'running') result.running += 1
          else if (task.status === 'pending') result.pending += 1
          else if (task.status === 'completed') result.completed += 1
        }
        return result
      }, [tasks])

      const submit = async (event) => {
        event.preventDefault()
        if (!input.trim() || submitting) return
        setSubmitting(true)
        setNotice('')
        setError('')
        try {
          const payload = {
            input: input.trim(),
            limit: moduleInfo.fixed ? 1 : Math.max(1, Number(count) || 20),
            task_type: moduleType,
          }
          if (moduleInfo.needsTarget && target.trim()) payload.target = target.trim()
          if (device) payload.device_serial = device
          const created = await api('/create', { method: 'POST', body: payload })
          setNotice(`任务 #${created.task_id} 已创建，切换到「任务」看进度。`)
          setInput('')
          setTab('tasks')
          await refresh()
        } catch (err) {
          setError(err.message || String(err))
        } finally {
          setSubmitting(false)
        }
      }

      const act = async (task, action) => {
        try {
          await api('/action', { method: 'POST', body: { id: Number(task.task_id), action } })
          await refresh()
        } catch (err) {
          setError(err.message || String(err))
        }
      }

      const coreAction = async (action) => {
        if (coreBusy) return
        setCoreBusy(true)
        setNotice('')
        setError('')
        try {
          await api(`/core/${action}`, { method: 'POST', body: {} })
          await refresh()
        } catch (err) {
          setError(err.message || String(err))
        } finally {
          setCoreBusy(false)
        }
      }

      const selectModule = (type) => {
        setModuleType(type)
        setCount(MODULE_BY_TYPE[type]?.fixed ? 1 : 20)
        setNotice('')
      }

      return h(
        'div',
        { className: 'xwb-root' },
        h(Styles),
        h(
          'header',
          { className: 'xwb-head' },
          h(
            'div',
            { className: 'xwb-head-main' },
            h('div', { className: 'xwb-title' }, '工蜂 · 小红书选品采集'),
            h(
              'div',
              { className: 'xwb-sub' },
              connected
                ? `已连接 ${shortHost(status.base)} · 设备 ${devices.length} 台 · 采集中 ${counts.running} 个任务`
                : status === null
                  ? '正在连接采集核心…'
                  : status?.core?.status === 'starting'
                    ? '正在启动采集核心…'
                    : status?.core?.running
                      ? '核心已启动，等待接口就绪'
                      : '采集核心未运行',
              status?.source ? h('span', { className: 'xwb-source', title: status.source }, 'discovery') : null,
            ),
          ),
          h(
            'div',
            { className: 'xwb-head-actions' },
            h('span', { className: connected ? 'xwb-dot xwb-dot-on' : 'xwb-dot xwb-dot-off' }),
            h('button', { className: 'xwb-btn', type: 'button', onClick: refresh }, '刷新'),
          ),
        ),
        error ? h('div', { className: 'xwb-alert' }, error) : null,
        notice ? h('div', { className: 'xwb-notice' }, notice) : null,
        h(
          'nav',
          { className: 'xwb-tabs' },
          [
            ['pools', '机会池'],
            ['compose', '发起采集'],
            ['tasks', `任务${tasks.length ? `（${tasks.length}）` : ''}`],
            ['devices', `设备${devices.length ? `（${devices.length}）` : ''}`],
          ].map(([key, label]) =>
            h(
              'button',
              {
                key,
                type: 'button',
                className: tab === key ? 'xwb-tab xwb-tab-on' : 'xwb-tab',
                onClick: () => setTab(key),
              },
              label,
            ),
          ),
        ),
        h(
          'main',
          { className: 'xwb-body' },
          !connected && status !== null
            ? h(CoreSetup, {
                status,
                busy: coreBusy,
                onStart: () => coreAction('start'),
                onStop: () => coreAction('stop'),
              })
            : null,

          tab === 'pools' ? h(PoolsPage, null) : null,

          tab === 'compose'
            ? h(
                'form',
                { className: 'xwb-compose', onSubmit: submit },
                h(
                  'div',
                  { className: 'xwb-groups' },
                  MODULE_GROUPS.map((group) =>
                    h(
                      'div',
                      { className: 'xwb-group', key: group },
                      h('div', { className: 'xwb-group-title' }, group),
                      h(
                        'div',
                        { className: 'xwb-modules' },
                        MODULES.filter((item) => item.group === group).map((item) =>
                          h(
                            'button',
                            {
                              key: item.type,
                              type: 'button',
                              className: moduleType === item.type ? 'xwb-module xwb-module-on' : 'xwb-module',
                              onClick: () => selectModule(item.type),
                            },
                            h('div', { className: 'xwb-module-title' }, item.title),
                            h('div', { className: 'xwb-module-desc' }, item.desc),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
                h(
                  'div',
                  { className: 'xwb-form' },
                  h(
                    Field,
                    { label: moduleInfo.input === 'keyword' ? '关键词' : '链接（一行一条可批量）' },
                    h('textarea', {
                      className: 'xwb-input xwb-textarea',
                      rows: 3,
                      value: input,
                      placeholder: moduleInfo.placeholder,
                      onChange: (event) => setInput(event.target.value),
                    }),
                  ),
                  moduleInfo.needsTarget
                    ? h(
                        Field,
                        { label: '目标商家（ID 或店铺/商品链接）' },
                        h('input', {
                          className: 'xwb-input',
                          value: target,
                          placeholder: '商家 ID，或店铺/商品链接',
                          onChange: (event) => setTarget(event.target.value),
                        }),
                      )
                    : null,
                  h(
                    'div',
                    { className: 'xwb-form-row' },
                    moduleInfo.fixed
                      ? h('div', { className: 'xwb-fixed' }, '该模块固定采集 1 条')
                      : h(
                          Field,
                          { label: `采集数量：${count} 条` },
                          h('input', {
                            className: 'xwb-range',
                            type: 'range',
                            min: 1,
                            max: 200,
                            value: count,
                            onChange: (event) => setCount(Number(event.target.value))},
                          ),
                        ),
                    h(
                      Field,
                      { label: '执行手机' },
                      h(
                        'select',
                        { className: 'xwb-input', value: device, onChange: (event) => setDevice(event.target.value) },
                        h('option', { value: '' }, '自动选机'),
                        devices.map((item) =>
                          h('option', { value: item.serial, key: item.serial }, `${item.name || item.serial}${item.online ? '（在线）' : '（离线）'}`),
                        ),
                      ),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'xwb-submit-row' },
                    h('button', { className: 'xwb-primary', type: 'submit', disabled: submitting || !input.trim() || !connected }, submitting ? '正在建单…' : connected ? '开始采集' : '先连接工蜂'),
                    h('span', { className: 'xwb-muted' }, connected ? '采集是异步的，建单后到「任务」看进度' : '先连上工蜂才能采集'),
                  ),
                  h(
                    'p',
                    { className: 'xwb-hint' },
                    '也可以直接在对话里说：',
                    h('code', null, '用工蜂采集「陶瓷马克杯」20 条'),
                    '，Agent 会调用同一套采集接口。',
                  ),
                ),
              )
            : null,

          tab === 'tasks'
            ? h(
                'div',
                { className: 'xwb-tasks' },
                tasks.length === 0
                  ? h('div', { className: 'xwb-empty' }, connected ? '还没有任务。去「发起采集」建第一个。' : '还没有连上工蜂。')
                  : tasks.map((task) =>
                      h(
                        'div',
                        { className: 'xwb-task', key: task.task_id },
                        h(
                          'div',
                          { className: 'xwb-task-main', onClick: () => setSelected(task), role: 'button', tabIndex: 0 },
                          h(
                            'div',
                            { className: 'xwb-task-title' },
                            h('span', { className: 'xwb-task-id' }, `#${task.task_id}`),
                            h('span', { className: 'xwb-task-type' }, MODULE_BY_TYPE[task.task_type]?.title || task.task_type || '采集'),
                            h(StatusBadge, { status: task.status }),
                          ),
                          h('div', { className: 'xwb-task-input xwb-ellipsis' }, textOf(task.input) || '—'),
                          h(
                            'div',
                            { className: 'xwb-task-meta' },
                            h('span', null, `${task.parsed_count || 0}/${task.target_count || 0} 条`),
                            h('span', { className: 'xwb-muted' }, formatTime(task.created_at)),
                          ),
                        ),
                        h(
                          'div',
                          { className: 'xwb-task-actions' },
                          h('button', { className: 'xwb-btn', type: 'button', onClick: () => setSelected(task) }, '看结果'),
                          ['pending', 'running'].includes(task.status)
                            ? h('button', { className: 'xwb-btn', type: 'button', onClick: () => act(task, 'cancel') }, '取消')
                            : null,
                          ['failed', 'partial', 'cancelled'].includes(task.status)
                            ? h('button', { className: 'xwb-btn', type: 'button', onClick: () => act(task, 'retry') }, '重试')
                            : null,
                        ),
                      ),
                    ),
              )
            : null,

          tab === 'devices'
            ? h(
                'div',
                { className: 'xwb-devices' },
                devices.length === 0
                  ? h(
                      'div',
                      { className: 'xwb-empty' },
                      status?.devicesUnsupported
                        ? '当前核心版本不提供设备列表；建单时由执行器自动选机。'
                        : connected
                          ? '核心没有识别到手机。用 USB 连上安卓机、打开 USB 调试后再刷新。'
                          : '还没有连上采集核心。',
                    )
                  : devices.map((item) =>
                      h(
                        'div',
                        { className: 'xwb-device', key: item.serial },
                        h('div', { className: item.online ? 'xwb-dot xwb-dot-on' : 'xwb-dot xwb-dot-off' }),
                        h(
                          'div',
                          { className: 'xwb-device-body' },
                          h('div', { className: 'xwb-device-name' }, item.name || item.serial),
                          h('div', { className: 'xwb-muted xwb-device-serial' }, item.serial),
                        ),
                        h(
                          'div',
                          { className: 'xwb-device-state' },
                          h('span', null, item.online ? '在线' : '离线'),
                          item.busy ? h('span', { className: 'xwb-tag' }, `采集中 #${item.current_task_id || ''}`) : null,
                        ),
                      ),
                    ),
              )
            : null,
        ),
        selected
          ? h(ResultDialog, {
              task: selected,
              onClose: () => setSelected(null),
              onRefresh: refresh,
            })
          : null,
      )
    }

    const POOL_STATUS = [
      ['all', '全部'],
      ['confirmed', '已确认'],
      ['candidate', '未复核'],
      ['observed', '观察'],
      ['rejected', '已排除'],
    ]

    const POOL_SORTS = [
      ['daily_revenue:desc', '日营业额'],
      ['total_revenue:desc', '累计营业额'],
      ['cart:desc', '24小时加购'],
      ['sold:desc', '已售'],
      ['price:desc', '价格'],
      ['created_at:desc', '入池时间'],
    ]

    function PoolsPage() {
      const [pools, setPools] = useState([])
      const [totals, setTotals] = useState({})
      const [pool, setPool] = useState('')
      const [status, setStatus] = useState('all')
      const [favoriteOnly, setFavoriteOnly] = useState(false)
      const [query, setQuery] = useState('')
      const [debounced, setDebounced] = useState('')
      const [sort, setSort] = useState('daily_revenue:desc')
      const [page, setPage] = useState(1)
      const pageSize = 20
      const [items, setItems] = useState([])
      const [total, setTotal] = useState(0)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState('')
      const [detailId, setDetailId] = useState('')
      const [detail, setDetail] = useState(null)
      const [detailLoading, setDetailLoading] = useState(false)
      const [detailError, setDetailError] = useState('')

      const loadPools = useCallback(async () => {
        try {
          const payload = await api('/pools')
          setPools(payload.pools || [])
          setTotals(payload.totals || {})
        } catch (err) {
          setError(err.message || String(err))
        }
      }, [])

      const loadItems = useCallback(async () => {
        setLoading(true)
        setError('')
        try {
          const params = new URLSearchParams()
          if (pool) params.set('pool', pool)
          params.set('status', status)
          if (debounced) params.set('q', debounced)
          params.set('sort', sort)
          params.set('page', String(page))
          params.set('page_size', String(pageSize))
          if (favoriteOnly) params.set('favorite_only', '1')
          const payload = await api(`/pool/items?${params.toString()}`)
          setItems(Array.isArray(payload.items) ? payload.items : [])
          setTotal(Number(payload.total) || 0)
        } catch (err) {
          setError(err.message || String(err))
          setItems([])
          setTotal(0)
        } finally {
          setLoading(false)
        }
      }, [pool, status, debounced, sort, page, favoriteOnly])

      useEffect(() => {
        loadPools()
      }, [loadPools])

      useEffect(() => {
        const timer = setTimeout(() => setDebounced(query.trim()), 300)
        return () => clearTimeout(timer)
      }, [query])

      useEffect(() => {
        loadItems()
      }, [loadItems])

      useEffect(() => {
        if (!detailId) {
          setDetail(null)
          return
        }
        let alive = true
        setDetailLoading(true)
        setDetailError('')
        api(`/pool/item?item_id=${encodeURIComponent(detailId)}`)
          .then((payload) => {
            if (alive) setDetail(payload.item || null)
          })
          .catch((err) => {
            if (alive) setDetailError(err.message || String(err))
          })
          .finally(() => {
            if (alive) setDetailLoading(false)
          })
        return () => {
          alive = false
        }
      }, [detailId])

      useEffect(() => {
        if (!detailId) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') setDetailId('')
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [detailId])

      const toggleFavorite = async (item) => {
        const next = !item.favorite
        setItems((current) =>
          current.map((row) => (row.item_id === item.item_id ? { ...row, favorite: next } : row)),
        )
        try {
          await api('/pool/favorite', {
            method: 'POST',
            body: { item_id: item.item_id, favorite: next },
          })
        } catch (err) {
          setError(err.message || String(err))
          setItems((current) =>
            current.map((row) => (row.item_id === item.item_id ? { ...row, favorite: !next } : row)),
          )
        }
      }

      const pages = Math.max(1, Math.ceil(total / pageSize))
      const resetPage = (fn) => (...args) => {
        setPage(1)
        fn(...args)
      }

      return h(
        'div',
        { className: 'xwb-pools' },
        h(
          'div',
          { className: 'xwb-pool-head' },
          h(
            'div',
            { className: 'xwb-pool-kpis' },
            h('div', { className: 'xwb-kpi' }, h('span', { className: 'xwb-kpi-label' }, '池内商品'), h('b', null, totals.items_total || 0)),
            h('div', { className: 'xwb-kpi' }, h('span', { className: 'xwb-kpi-label' }, '今日新增'), h('b', null, totals.today_new || 0)),
            h('div', { className: 'xwb-kpi' }, h('span', { className: 'xwb-kpi-label' }, '行业池'), h('b', null, pools.length)),
          ),
          h('input', {
            className: 'xwb-input xwb-pool-search',
            value: query,
            placeholder: '搜商品名 / 店铺 / 关键词',
            onChange: (event) => resetPage(setQuery)(event.target.value),
          }),
          h(
            'select',
            {
              className: 'xwb-input xwb-pool-sort',
              value: sort,
              onChange: (event) => resetPage(setSort)(event.target.value),
            },
            POOL_SORTS.map(([value, label]) => h('option', { value, key: value }, `按${label}`)),
          ),
          h('button', { className: 'xwb-btn', type: 'button', onClick: () => { loadPools(); loadItems() } }, '刷新'),
        ),
        h(
          'div',
          { className: 'xwb-pool-chips' },
          h(
            'button',
            { type: 'button', className: pool === '' ? 'xwb-chip xwb-chip-on' : 'xwb-chip', onClick: () => resetPage(setPool)('') },
            '全部池',
          ),
          pools.map((entry) =>
            h(
              'button',
              {
                key: entry.id,
                type: 'button',
                className: pool === entry.name ? 'xwb-chip xwb-chip-on' : 'xwb-chip',
                title: entry.description || '',
                onClick: () => resetPage(setPool)(entry.name),
              },
              `${entry.name} · ${entry.items_total || 0}`,
            ),
          ),
        ),
        h(
          'div',
          { className: 'xwb-pool-chips' },
          POOL_STATUS.map(([value, label]) =>
            h(
              'button',
              {
                key: value,
                type: 'button',
                className: !favoriteOnly && status === value ? 'xwb-chip xwb-chip-on' : 'xwb-chip',
                onClick: () => {
                  setFavoriteOnly(false)
                  resetPage(setStatus)(value)
                },
              },
              label,
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              className: favoriteOnly ? 'xwb-chip xwb-chip-on' : 'xwb-chip',
              onClick: () => {
                setFavoriteOnly((value) => !value)
                setPage(1)
              },
            },
            '★ 收藏',
          ),
          h('span', { className: 'xwb-muted xwb-pool-count' }, `共 ${total} 条`),
        ),
        error ? h('div', { className: 'xwb-alert' }, error) : null,
        h(
          'div',
          { className: 'xwb-table-wrap' },
          h(
            'div',
            { className: 'xwb-table' },
            h(
              'div',
              { className: 'xwb-tr xwb-thead', role: 'row' },
              h('span', null, ''),
              h('span', null, '商品'),
              h('span', { className: 'xwb-num' }, '价格'),
              h('span', { className: 'xwb-num' }, '已售'),
              h('span', { className: 'xwb-num' }, '24h加购'),
              h('span', { className: 'xwb-num' }, '日营业额'),
              h('span', { className: 'xwb-num' }, '累计营业额'),
              h('span', null, '来源词'),
              h('span', null, '所属池'),
              h('span', null, '店铺'),
              h('span', { className: 'xwb-num' }, '入池时间'),
            ),
            loading
              ? h('div', { className: 'xwb-empty' }, '正在读取机会池…')
              : items.length === 0
                ? h(
                    'div',
                    { className: 'xwb-empty' },
                    favoriteOnly
                      ? '还没有收藏的商品'
                      : pools.length === 0
                        ? '核心还没有行业池。先在核心侧建池并跑采集，商品会自动入池。'
                        : query
                          ? `没有匹配「${query}」的商品`
                          : '这个分组下还没有商品',
                  )
                : items.map((item) => {
                    const biz = bizOf(item)
                    return h(
                      'div',
                      {
                        className: detailId === item.item_id ? 'xwb-tr xwb-tr-on' : 'xwb-tr',
                        key: item.item_id,
                        role: 'row',
                        onClick: () => setDetailId(item.item_id),
                      },
                      h(
                        'span',
                        {
                          className: item.favorite ? 'xwb-star xwb-star-on' : 'xwb-star',
                          role: 'button',
                          title: item.favorite ? '取消收藏' : '收藏',
                          onClick: (event) => {
                            event.stopPropagation()
                            toggleFavorite(item)
                          },
                        },
                        item.favorite ? '★' : '☆',
                      ),
                      h(
                        'span',
                        { className: 'xwb-cell-title' },
                        h('span', { className: 'xwb-ellipsis', title: item.title || item.item_id }, item.title || item.item_id),
                        item.is_24h_cart_hit ? h('span', { className: 'xwb-hit' }, '24h加购') : null,
                      ),
                      h('span', { className: 'xwb-num' }, priceText(item.price)),
                      h('span', { className: 'xwb-num' }, soldText(item)),
                      h('span', { className: 'xwb-num' }, biz.cart ? compact(biz.cart) : '—'),
                      h('span', { className: 'xwb-num xwb-strong' }, money(biz.daily)),
                      h('span', { className: 'xwb-num' }, money(biz.total)),
                      h('span', { className: 'xwb-ellipsis xwb-muted', title: item.keyword || '' }, item.keyword || '—'),
                      h('span', { className: 'xwb-ellipsis xwb-muted', title: item.pool || '' }, item.pool || '—'),
                      h('span', { className: 'xwb-ellipsis', title: item.shop_name || '' }, item.shop_name || '—'),
                      h('span', { className: 'xwb-num xwb-muted' }, dateTime(item.collected_at)),
                    )
                  }),
          ),
        ),
        h(
          'div',
          { className: 'xwb-pager' },
          h('button', { className: 'xwb-btn', type: 'button', disabled: page <= 1, onClick: () => setPage((value) => Math.max(1, value - 1)) }, '上一页'),
          h('span', { className: 'xwb-muted' }, `第 ${page} / ${pages} 页`),
          h('button', { className: 'xwb-btn', type: 'button', disabled: page >= pages, onClick: () => setPage((value) => Math.min(pages, value + 1)) }, '下一页'),
        ),
        detailId
          ? h(PoolDetail, {
              item: detail,
              fallback: items.find((row) => row.item_id === detailId) || null,
              loading: detailLoading,
              error: detailError,
              onClose: () => setDetailId(''),
              onFavorite: (item) => toggleFavorite(item),
            })
          : null,
      )
    }

    function PoolDetail({ item, fallback, loading, error, onClose, onFavorite }) {
      const data = item || fallback || {}
      const images = (item?.main_images || []).slice(0, 9)
      const tags = item?.selling_point_tags || []
      const hitTags = item?.hit_tags || []
      return h(
        'div',
        { className: 'xwb-drawer', role: 'dialog', 'aria-modal': 'true' },
        h('div', { className: 'xwb-drawer-backdrop', onClick: onClose }),
        h(
          'aside',
          { className: 'xwb-drawer-panel' },
          h(
            'header',
            { className: 'xwb-drawer-head' },
            h('b', null, '商品详情'),
            h(
              'div',
              { className: 'xwb-drawer-actions' },
              h(
                'button',
                { className: 'xwb-btn', type: 'button', onClick: () => onFavorite(data) },
                data.favorite ? '★ 已收藏' : '☆ 收藏',
              ),
              data.url ? h('a', { className: 'xwb-btn', href: data.url, target: '_blank', rel: 'noreferrer' }, '打开原页') : null,
              h('button', { className: 'xwb-btn', type: 'button', onClick: onClose }, '关闭'),
            ),
          ),
          h(
            'div',
            { className: 'xwb-drawer-body' },
            loading ? h('div', { className: 'xwb-empty' }, '正在读取详情…') : null,
            error ? h('div', { className: 'xwb-alert' }, error) : null,
            !loading && !error
              ? h(
                  'div',
                  { className: 'xwb-detail' },
                  h('div', { className: 'xwb-detail-title' }, data.title || data.item_id || '未命名商品'),
                  h(
                    'div',
                    { className: 'xwb-product-meta' },
                    data.price !== undefined ? h('span', { className: 'xwb-price' }, `¥${priceText(data.price)}`) : null,
                    data.original_price ? h('span', { className: 'xwb-muted xwb-strike' }, `¥${priceText(data.original_price)}`) : null,
                    data.sold_text ? h('span', { className: 'xwb-muted' }, data.sold_text) : null,
                    data.is_24h_cart_hit ? h('span', { className: 'xwb-hit' }, '24小时加购命中') : null,
                  ),
                  images.length
                    ? h(
                        'div',
                        { className: 'xwb-gallery' },
                        images.map((url) =>
                          h('img', { key: url, className: 'xwb-gallery-img', src: mediaUrl(url), alt: '', loading: 'lazy' }),
                        ),
                      )
                    : null,
                  hitTags.length
                    ? h('div', { className: 'xwb-tags' }, hitTags.map((tag, index) => h('span', { className: 'xwb-tag xwb-tag-hit', key: `${tag}-${index}` }, tag)))
                    : null,
                  tags.length
                    ? h('div', { className: 'xwb-tags' }, tags.map((tag, index) => h('span', { className: 'xwb-tag', key: `${tag}-${index}` }, tag)))
                    : null,
                  h(
                    'div',
                    { className: 'xwb-kv' },
                    h('span', { className: 'xwb-kv-key' }, '店铺'),
                    h('span', { className: 'xwb-kv-value' }, data.shop_name || '—'),
                    h('span', { className: 'xwb-kv-key' }, '粉丝 / 销量'),
                    h('span', { className: 'xwb-kv-value' }, `${data.seller_fans ?? '—'} / ${data.seller_sales ?? '—'}`),
                    h('span', { className: 'xwb-kv-key' }, '物流'),
                    h(
                      'span',
                      { className: 'xwb-kv-value' },
                      [data.logistics?.location, data.logistics?.shipment_time, data.logistics?.fee].filter(Boolean).join(' · ') || '—',
                    ),
                    h('span', { className: 'xwb-kv-key' }, '入池时间'),
                    h('span', { className: 'xwb-kv-value' }, dateTime(data.created_at)),
                  ),
                  data.url
                    ? h('a', { className: 'xwb-link', href: data.url, target: '_blank', rel: 'noreferrer' }, '小红书商品页')
                    : null,
                  h('details', { className: 'xwb-raw' }, h('summary', null, '原始 JSON'), h('pre', { className: 'xwb-json' }, JSON.stringify(data, null, 2))),
                )
              : null,
          ),
        ),
      )
    }

    function CoreSetup({ status, busy, onStart, onStop }) {
      const core = status?.core || {}
      const installed = Boolean(core.installed)
      const busyCore = ['starting', 'stopping'].includes(core.status) || busy

      if (!installed) {
        return h(
          'section',
          { className: 'xwb-guide' },
          h('div', { className: 'xwb-guide-title' }, '采集核心还没安装'),
          h(
            'ol',
            { className: 'xwb-guide-list' },
            h('li', null, '把采集核心放进插件目录：dsh-plugin/runtime/core/（macOS/Linux 放 xhs-core，Windows 放 xhs-core.exe）。'),
            h('li', null, '或者在 dsh-plugin/config.json 里写 {"core":{"path":"/绝对路径/core"}}。'),
            h('li', null, '刷新页面，然后点下面的「启动核心」。'),
          ),
          h('div', { className: 'xwb-muted xwb-guide-path' }, '核心是工蜂的采集执行程序（真机驱动 + 解析），插件只负责把它拉起来并显示结果。'),
        )
      }

      const starting = core.status === 'starting'
      return h(
        'section',
        { className: 'xwb-guide' },
        h('div', { className: 'xwb-guide-title' }, starting ? '正在启动采集核心…' : '采集核心已安装，但没有连上'),
        h('div', { className: 'xwb-muted xwb-guide-path' }, `核心：${core.binary}`),
        h('div', { className: 'xwb-muted xwb-guide-path' }, `数据目录：${core.dataDir}`),
        core.error ? h('div', { className: 'xwb-alert-inline' }, core.error) : null,
        status?.message && !core.error ? h('div', { className: 'xwb-alert-inline' }, status.message) : null,
        h(
          'div',
          { className: 'xwb-guide-actions' },
          h(
            'button',
            { className: 'xwb-primary', type: 'button', disabled: busyCore, onClick: onStart },
            starting ? '启动中…' : core.running ? '重新启动' : '启动核心',
          ),
          core.running || starting
            ? h('button', { className: 'xwb-btn', type: 'button', disabled: busyCore, onClick: onStop }, '停止核心')
            : null,
          h('span', { className: 'xwb-muted xwb-guide-path' }, `日志：${core.logPath}`),
        ),
      )
    }

    const WorkbenchIcon = ({ size = 20, active = false }) =>
      h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, style: { display: 'block' } },
        h('path', {
          d: 'M12 3.2 19.6 7.6v8.8L12 20.8 4.4 16.4V7.6L12 3.2Z',
          fill: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor',
          opacity: active ? 1 : 0.75,
        }),
        h('path', {
          d: 'M7.2 9.2c1.7 1.1 3 1.1 4.8 0M7.2 12.4c1.7 1.1 3 1.1 4.8 0M7.2 15.6c1.7 1.1 3 1.1 4.8 0',
          stroke: 'var(--dsw-alias-bg-base)',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
        }),
      )

    /* ---------------- 样式（只用 --dsw-alias-* 主题变量） ---------------- */

    const CSS = `
.xwb-root { display: flex; flex-direction: column; min-height: 100%; height: 100%; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 13px; }
.xwb-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 20px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.xwb-head-main { min-width: 0; }
.xwb-title { font-size: 15px; font-weight: 600; }
.xwb-sub { margin-top: 4px; font-size: 12px; color: var(--dsw-alias-label-secondary); display: flex; gap: 8px; align-items: center; }
.xwb-source { font-size: 11px; padding: 1px 6px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; }
.xwb-head-actions { display: flex; align-items: center; gap: 10px; }
.xwb-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: none; }
.xwb-dot-on { background: var(--dsw-alias-state-success-primary); }
.xwb-dot-off { background: var(--dsw-alias-state-idle-primary); }
.xwb-btn { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border-radius: 7px; padding: 5px 10px; font-size: 12px; cursor: pointer; }
.xwb-btn:hover { border-color: var(--dsw-alias-border-l2); }
.xwb-primary { border: none; background: var(--dsw-alias-brand-primary); color: #fff; border-radius: 8px; padding: 9px 18px; font-size: 13px; font-weight: 600; cursor: pointer; }
.xwb-primary:disabled { opacity: .45; cursor: not-allowed; }
.xwb-alert { margin: 10px 20px 0; padding: 9px 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-bg-layer-1); font-size: 12px; }
.xwb-alert-inline { margin-top: 8px; color: var(--dsw-alias-state-error-primary); font-size: 12px; }
.xwb-notice { margin: 10px 20px 0; padding: 9px 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); background: var(--dsw-alias-bg-layer-1); font-size: 12px; }
.xwb-tabs { display: flex; gap: 4px; padding: 10px 20px 0; }
.xwb-tab { border: none; background: transparent; color: var(--dsw-alias-label-secondary); padding: 7px 12px; border-radius: 7px; font-size: 13px; cursor: pointer; }
.xwb-tab:hover { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.xwb-tab-on { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-weight: 600; }
.xwb-body { flex: 1; min-height: 0; overflow: auto; padding: 12px 20px 24px; }
.xwb-guide { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 14px 16px; background: var(--dsw-alias-bg-layer-1); margin: 4px 0 16px; }
.xwb-guide-title { font-weight: 600; margin-bottom: 8px; }
.xwb-guide-list { margin: 0; padding-left: 18px; color: var(--dsw-alias-label-secondary); line-height: 1.9; }
.xwb-guide-path { margin-top: 6px; font-size: 11px; word-break: break-all; }
.xwb-guide-actions { display: flex; align-items: center; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
.xwb-groups { display: flex; flex-direction: column; gap: 14px; }
.xwb-group-title { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-bottom: 6px; }
.xwb-modules { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 8px; }
.xwb-module { text-align: left; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: inherit; border-radius: 9px; padding: 9px 11px; cursor: pointer; }
.xwb-module:hover { border-color: var(--dsw-alias-border-l2); }
.xwb-module-on { border-color: var(--dsw-alias-brand-primary); box-shadow: inset 0 0 0 1px var(--dsw-alias-brand-primary); }
.xwb-module-title { font-size: 13px; font-weight: 600; }
.xwb-module-desc { margin-top: 3px; font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 1.5; }
.xwb-form { margin-top: 16px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 14px 16px; background: var(--dsw-alias-bg-layer-1); display: flex; flex-direction: column; gap: 12px; }
.xwb-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.xwb-field-label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.xwb-input { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: inherit; border-radius: 7px; padding: 7px 9px; font-size: 13px; font-family: inherit; outline: none; }
.xwb-input:focus { border-color: var(--dsw-alias-brand-primary); }
.xwb-textarea { resize: vertical; min-height: 62px; }
.xwb-form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: end; }
.xwb-range { width: 100%; accent-color: var(--dsw-alias-brand-primary); }
.xwb-fixed { font-size: 12px; color: var(--dsw-alias-label-secondary); padding-bottom: 8px; }
.xwb-submit-row { display: flex; align-items: center; gap: 12px; }
.xwb-hint { margin: 0; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.xwb-hint code { background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px; padding: 1px 5px; }
.xwb-tasks { display: flex; flex-direction: column; gap: 6px; }
.xwb-task { display: flex; align-items: center; gap: 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; padding: 9px 12px; background: var(--dsw-alias-bg-layer-1); }
.xwb-task-main { flex: 1; min-width: 0; cursor: pointer; display: flex; flex-direction: column; gap: 4px; }
.xwb-task-title { display: flex; align-items: center; gap: 8px; }
.xwb-task-id { font-weight: 600; font-variant-numeric: tabular-nums; }
.xwb-task-type { font-size: 12px; }
.xwb-task-input { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.xwb-task-meta { display: flex; gap: 12px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.xwb-task-actions { display: flex; gap: 6px; flex: none; }
.xwb-badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }
.xwb-badge-running { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.xwb-badge-completed { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.xwb-badge-partial { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.xwb-badge-failed { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.xwb-devices { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
.xwb-device { display: flex; align-items: center; gap: 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 12px; background: var(--dsw-alias-bg-layer-1); }
.xwb-device-body { flex: 1; min-width: 0; }
.xwb-device-name { font-weight: 600; }
.xwb-device-serial { font-size: 11px; word-break: break-all; }
.xwb-device-state { display: flex; flex-direction: column; gap: 4px; align-items: flex-end; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.xwb-empty { padding: 40px 0; text-align: center; color: var(--dsw-alias-label-secondary); }
.xwb-muted { color: var(--dsw-alias-label-secondary); }
.xwb-ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.xwb-modal { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; padding: 32px; }
.xwb-modal-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.45); }
.xwb-modal-panel { position: relative; width: min(980px, 100%); height: min(760px, 100%); display: flex; flex-direction: column; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; overflow: hidden; }
.xwb-modal-head { display: flex; justify-content: space-between; gap: 16px; padding: 12px 16px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.xwb-modal-title { min-width: 0; }
.xwb-modal-name { font-weight: 600; }
.xwb-modal-actions { display: flex; gap: 6px; align-items: center; flex: none; }
.xwb-modal-body { flex: 1; overflow: auto; padding: 14px 16px; }
.xwb-modal-foot { display: flex; justify-content: space-between; align-items: center; padding: 10px 16px; border-top: 1px solid var(--dsw-alias-border-l1); font-size: 12px; }
.xwb-section-title { margin: 4px 0 10px; font-size: 12px; color: var(--dsw-alias-label-secondary); font-weight: 600; }
.xwb-list { display: flex; flex-direction: column; gap: 10px; margin-bottom: 18px; }
.xwb-card { display: flex; gap: 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 10px; background: var(--dsw-alias-bg-base); }
.xwb-thumb { width: 84px; height: 84px; border-radius: 8px; object-fit: cover; flex: none; background: var(--dsw-alias-bg-layer-2); }
.xwb-thumb-empty { display: flex; align-items: center; justify-content: center; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.xwb-product-body { min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.xwb-product-title { font-weight: 600; line-height: 1.4; }
.xwb-product-meta { display: flex; flex-wrap: wrap; gap: 10px; font-size: 12px; }
.xwb-price { color: var(--dsw-alias-state-error-primary); font-weight: 600; }
.xwb-strike { text-decoration: line-through; }
.xwb-seller { display: flex; flex-wrap: wrap; gap: 10px; font-size: 12px; }
.xwb-tags { display: flex; flex-wrap: wrap; gap: 5px; }
.xwb-tag { font-size: 11px; padding: 1px 6px; border-radius: 4px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
.xwb-link { font-size: 12px; color: var(--dsw-alias-brand-primary); text-decoration: none; }
.xwb-link:hover { text-decoration: underline; }
.xwb-body-text { margin: 0; font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.6; }
.xwb-comments { display: flex; flex-direction: column; gap: 8px; margin-bottom: 18px; }
.xwb-comment { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 9px 11px; background: var(--dsw-alias-bg-base); }
.xwb-comment-head { display: flex; gap: 10px; font-size: 12px; }
.xwb-comment-body { margin: 5px 0; line-height: 1.6; }
.xwb-comment-foot { display: flex; gap: 10px; font-size: 11px; }
.xwb-kv { display: grid; grid-template-columns: 160px 1fr; gap: 6px 14px; font-size: 12px; margin-bottom: 18px; }
.xwb-kv-row { display: contents; }
.xwb-kv-key { color: var(--dsw-alias-label-secondary); }
.xwb-kv-value { word-break: break-all; }
.xwb-json { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-all; }
.xwb-pools { display: flex; flex-direction: column; gap: 10px; }
.xwb-pool-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.xwb-pool-kpis { display: flex; gap: 14px; margin-right: auto; }
.xwb-kpi { display: flex; flex-direction: column; gap: 2px; min-width: 64px; }
.xwb-kpi-label { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.xwb-kpi b { font-size: 18px; font-variant-numeric: tabular-nums; }
.xwb-pool-search { width: 220px; }
.xwb-pool-sort { width: 140px; }
.xwb-pool-chips { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.xwb-chip { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); border-radius: 999px; padding: 3px 10px; font-size: 12px; cursor: pointer; }
.xwb-chip:hover { border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); }
.xwb-chip-on { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.xwb-pool-count { margin-left: auto; font-size: 12px; }
.xwb-table-wrap { overflow: auto; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
.xwb-table { min-width: 1040px; }
.xwb-tr { display: grid; grid-template-columns: 28px minmax(240px, 1.8fr) 64px 72px 84px 92px 96px 100px 96px 120px 88px; gap: 8px; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); font-size: 12px; cursor: pointer; }
.xwb-tr:last-child { border-bottom: none; }
.xwb-tr:not(.xwb-thead):hover { background: var(--dsw-alias-bg-layer-2); }
.xwb-tr-on { background: var(--dsw-alias-bg-layer-2); }
.xwb-thead { color: var(--dsw-alias-label-secondary); font-size: 11px; cursor: default; position: sticky; top: 0; background: var(--dsw-alias-bg-layer-1); z-index: 1; }
.xwb-num { text-align: right; font-variant-numeric: tabular-nums; }
.xwb-strong { font-weight: 600; }
.xwb-cell-title { display: flex; align-items: center; gap: 6px; min-width: 0; }
.xwb-hit { flex: none; font-size: 10px; padding: 1px 5px; border-radius: 4px; background: var(--dsw-alias-state-error-primary); color: #fff; }
.xwb-star { cursor: pointer; color: var(--dsw-alias-state-idle-primary); font-size: 14px; user-select: none; }
.xwb-star-on { color: #e8a33d; }
.xwb-pager { display: flex; align-items: center; justify-content: flex-end; gap: 10px; font-size: 12px; }
.xwb-drawer { position: fixed; inset: 0; z-index: 61; display: flex; justify-content: flex-end; }
.xwb-drawer-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.35); }
.xwb-drawer-panel { position: relative; width: min(520px, 100%); height: 100%; background: var(--dsw-alias-bg-layer-1); border-left: 1px solid var(--dsw-alias-border-l2); display: flex; flex-direction: column; }
.xwb-drawer-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.xwb-drawer-actions { display: flex; gap: 6px; align-items: center; }
.xwb-drawer-body { flex: 1; overflow: auto; padding: 14px; }
.xwb-detail { display: flex; flex-direction: column; gap: 10px; }
.xwb-detail-title { font-size: 14px; font-weight: 600; line-height: 1.5; }
.xwb-gallery { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.xwb-gallery-img { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); }
.xwb-tag-hit { background: var(--dsw-alias-state-error-primary); color: #fff; }
.xwb-raw { margin-top: 4px; }
.xwb-raw summary { cursor: pointer; font-size: 12px; color: var(--dsw-alias-label-secondary); }
@media (max-width: 720px) { .xwb-form-row { grid-template-columns: 1fr; } .xwb-modal { padding: 0; } .xwb-modal-panel { border-radius: 0; } }
`

    /* ---------------- 注册 ---------------- */

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'xhs-workbench', order: 20, label: () => '工蜂选品' },
            WorkbenchIcon,
          ),
        )
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'xhs-workbench' }, Workbench),
        )
      },
    }
  },
})
