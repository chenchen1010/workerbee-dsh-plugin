/**
 * 工蜂 · 小红书选品采集 —— Host 半（Node / Cordis 插件）
 *
 * 这一半只做三件事：
 *   1. 找到本机正在运行的工蜂采集核心（读 discovery 文件，或 dsh-plugin/config.json）；
 *   2. 把 Agent 的采集动作注册成工具（建单 / 查任务 / 取结果 / 取消）；
 *   3. 给面板开同源 HTTP 路由，把钥匙留在 Host，不下发到浏览器。
 *
 * 它不碰手机、不碰数据库、不搬采集逻辑。采集核心始终是工蜂客户端里那份加固过的
 * 本机服务；本插件只是它的「大脑 + 界面」。
 */

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_DIR = fileURLToPath(new URL('.', import.meta.url))
const ROUTE_PREFIX = '/plugins/xhs-workbench'
const CSRF_HEADER = 'x-xhs-workbench'

/* ------------------------------------------------------------------ */
/* 连接：discovery 文件 → config.json → 环境变量                        */
/* ------------------------------------------------------------------ */

/** 工蜂 discovery 文件的候选位置，顺序即优先级。 */
function discoveryCandidates() {
  const home = homedir()
  const list = []

  if (process.env.XHS_WORKBENCH_DISCOVERY_PATH) {
    list.push(process.env.XHS_WORKBENCH_DISCOVERY_PATH)
  }

  if (platform() === 'win32') {
    // 桌面壳 app.getPath('appData') = %APPDATA%
    if (process.env.APPDATA) list.push(join(process.env.APPDATA, '工蜂', 'api.json'))
  } else if (platform() === 'darwin') {
    list.push(join(home, 'Library', 'Application Support', '工蜂', 'api.json'))
  } else {
    list.push(join(process.env.XDG_CONFIG_HOME || join(home, '.config'), '工蜂', 'api.json'))
  }

  // 手动兜底：客户自己写一份，不进 git
  list.push(join(PACKAGE_DIR, 'config.json'))
  return list
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

let cachedConnection = null
let cachedAt = 0

/**
 * 解析当前连接。返回 { base, key, source, pid } 或 null。
 * 结果缓存 3 秒，避免面板轮询把磁盘读爆。
 */
function resolveConnection({ fresh = false } = {}) {
  // 插件自己拉起的核心优先：地址和钥匙都在内存里，不依赖磁盘。
  if (coreState.status === 'running' && coreState.base && coreState.key) {
    return { base: coreState.base, key: coreState.key, source: 'managed-core', pid: coreState.pid }
  }

  const now = Date.now()
  if (!fresh && cachedConnection && now - cachedAt < 3000) return cachedConnection

  const fromEnv =
    (process.env.XHS_WORKBENCH_BASE || process.env.XHS_API_BASE_URL || '').trim() &&
    (process.env.XHS_WORKBENCH_KEY || process.env.XHS_API_KEY || '').trim()
  if (fromEnv) {
    const conn = {
      base: String(process.env.XHS_WORKBENCH_BASE || process.env.XHS_API_BASE_URL).trim().replace(/\/+$/, ''),
      key: String(process.env.XHS_WORKBENCH_KEY || process.env.XHS_API_KEY).trim(),
      source: 'env',
      pid: 0,
    }
    cachedConnection = conn
    cachedAt = now
    return conn
  }

  // config.json 里显式写了 base/key，就优先用它（覆盖自动发现，便于连远端/测试核心）。
  const explicit = readJsonFile(join(PACKAGE_DIR, 'config.json'))
  if (explicit && typeof explicit === 'object') {
    const base = String(explicit.base_url || explicit.base || '').trim().replace(/\/+$/, '')
    const key = String(explicit.key || '').trim()
    if (base && key) {
      const conn = { base, key, source: 'config.json', pid: 0 }
      cachedConnection = conn
      cachedAt = now
      return conn
    }
  }

  for (const path of discoveryCandidates()) {
    const record = readJsonFile(path)
    if (!record || typeof record !== 'object') continue
    const base = String(record.base_url || record.base || '').trim().replace(/\/+$/, '')
    const key = String(record.key || '').trim()
    if (!base || !key) continue
    const conn = { base, key, source: path, pid: Number(record.pid) || 0 }
    cachedConnection = conn
    cachedAt = now
    return conn
  }

  cachedConnection = null
  cachedAt = now
  return null
}

function discoveryHint() {
  if (platform() === 'win32') return '%APPDATA%\\工蜂\\api.json'
  if (platform() === 'darwin') return '~/Library/Application Support/工蜂/api.json'
  return '~/.config/工蜂/api.json'
}

/* ------------------------------------------------------------------ */
/* 采集核心进程托管                                                     */
/*                                                                     */
/* 插件不再依赖工蜂桌面壳：它自己拉起 xhs-core（PyInstaller/Nuitka 产物），  */
/* 管端口、数据库、discovery、日志和退出。核心仍是黑盒，插件只是外壳。       */
/* ------------------------------------------------------------------ */

const CORE_READY_TIMEOUT_MS = 30000
const CORE_POLL_MS = 500

const coreState = {
  proc: null,
  status: 'stopped', // stopped | starting | running | stopping | error
  base: '',
  key: '',
  port: 0,
  pid: 0,
  error: '',
  startedAt: 0,
  logPath: '',
  binary: '',
  stopping: false,
}

function appDataBase() {
  if (platform() === 'win32') return process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support')
  return process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
}

/** 插件目录下的 config.json：既可以只放连接信息，也可以放 core 配置。 */
function pluginConfig() {
  const record = readJsonFile(join(PACKAGE_DIR, 'config.json'))
  return record && typeof record === 'object' ? record : {}
}

function coreExeName() {
  return platform() === 'win32' ? 'xhs-core.exe' : 'xhs-core'
}

/**
 * 找采集核心可执行文件。顺序：
 *   env XHS_CORE_BIN → config.core.path → dsh-plugin/runtime/core/xhs-core
 * 路径可以是目录（自动拼 xhs-core），也可以是可执行文件本身。
 */
function resolveCoreBinary() {
  const exe = coreExeName()
  const config = pluginConfig()
  const candidates = [
    process.env.XHS_CORE_BIN,
    config?.core?.path,
    join(PACKAGE_DIR, 'runtime', 'core', exe),
    join(PACKAGE_DIR, 'runtime', exe),
  ].filter(Boolean)

  for (const candidate of candidates) {
    const raw = String(candidate)
    let target = raw
    try {
      if (existsSync(raw) && statSync(raw).isDirectory()) target = join(raw, exe)
    } catch {
      /* 目录判断失败就按文件试 */
    }
    if (existsSync(target)) return target
  }
  return ''
}

function coreDataDir() {
  const config = pluginConfig()
  return String(config?.core?.dataDir || '').trim() || join(appDataBase(), '工蜂')
}

function coreDbPath(dataDir) {
  const config = pluginConfig()
  return String(config?.core?.db || '').trim() || join(dataDir, 'xhs_links.db')
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error('拿不到空闲端口'))))
    })
  })
}

function appendCoreLog(dataDir, chunk) {
  try {
    const dir = join(dataDir, 'logs')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'core.log'), chunk)
  } catch {
    /* 日志失败不影响主流程 */
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function coreStatus() {
  const binary = coreState.binary || resolveCoreBinary()
  return {
    installed: Boolean(binary),
    binary,
    dataDir: coreDataDir(),
    status: coreState.status,
    running: coreState.status === 'running',
    base: coreState.base,
    port: coreState.port,
    pid: coreState.pid,
    error: coreState.error,
    logPath: coreState.logPath || join(coreDataDir(), 'logs', 'core.log'),
    uptimeSeconds: coreState.startedAt ? Math.max(0, Math.round((Date.now() - coreState.startedAt) / 1000)) : 0,
  }
}

async function waitCoreReady(base, timeoutMs = CORE_READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!coreState.proc) throw new WorkbenchError('采集核心启动后立刻退出了，去看日志。', 'CORE_EXITED')
    try {
      const response = await fetch(`${base}/api/state`, { signal: AbortSignal.timeout(2000) })
      if (response.ok) return
    } catch {
      /* 还没起来 */
    }
    await sleep(CORE_POLL_MS)
  }
  throw new WorkbenchError(`采集核心 ${Math.round(timeoutMs / 1000)} 秒内没有就绪，去看日志。`, 'CORE_TIMEOUT')
}

async function externalCoreReachable() {
  const conn = resolveConnection({ fresh: true })
  if (!conn) return ''
  try {
    const response = await fetch(`${conn.base}/api/state`, { signal: AbortSignal.timeout(1500) })
    return response.ok ? conn.base : ''
  } catch {
    return ''
  }
}

async function startCore() {
  if (coreState.status === 'running' && coreState.proc) return coreStatus()
  if (coreState.status === 'starting') throw new WorkbenchError('采集核心正在启动，稍等。', 'CORE_STARTING')

  // 一台手机只能有一个执行器：已有核心在跑时禁止再拉一个，避免两个 supervisor 抢设备。
  const existing = await externalCoreReachable()
  if (existing) {
    throw new WorkbenchError(
      `检测到已经在运行的采集核心（${existing}）。先停掉它，再启动插件托管的核心；` +
        '两个执行器同时跑会抢同一台手机。也可以直接用现有核心，不点启动。',
      'CORE_ALREADY_RUNNING',
    )
  }

  const binary = resolveCoreBinary()
  if (!binary) {
    throw new WorkbenchError(
      '没有找到采集核心。把 xhs-core（Windows 是 xhs-core.exe）放进 dsh-plugin/runtime/core/，' +
        '或者在 config.json 里写 {"core":{"path":"/绝对路径/core"}}。',
      'CORE_MISSING',
    )
  }

  const dataDir = coreDataDir()
  const dbPath = coreDbPath(dataDir)
  const discoveryFile = join(dataDir, 'api.json')
  mkdirSync(dataDir, { recursive: true })

  const port = Number(pluginConfig()?.core?.port) || (await freePort())
  const base = `http://127.0.0.1:${port}`
  // --db 是全局参数，必须放在 serve 之前（工蜂桌面壳也是这个顺序）。
  const args = ['--db', dbPath, 'serve', '--host', '127.0.0.1', '--port', String(port), '--discovery-file', discoveryFile]

  const env = { ...process.env }
  const config = pluginConfig()
  const cloudBase = String(config?.cloudBaseUrl || '').trim()
  if (cloudBase && !env.XHS_DESKTOP_CLOUD_BASE_URL) env.XHS_DESKTOP_CLOUD_BASE_URL = cloudBase
  if (config?.core?.enforceLicense) env.XHS_LICENSE_ENFORCE = '1'
  // 客户/调试可以透传额外 env（隔离 settings、指向云端、打开激活门禁等）。
  if (config?.core?.env && typeof config.core.env === 'object') {
    for (const [key, value] of Object.entries(config.core.env)) {
      if (value !== null && value !== undefined) env[key] = String(value)
    }
  }

  coreState.status = 'starting'
  coreState.error = ''
  coreState.base = base
  coreState.port = port
  coreState.binary = binary
  coreState.stopping = false
  coreState.startedAt = Date.now()
  coreState.logPath = join(dataDir, 'logs', 'core.log')

  const proc = spawn(binary, args, {
    cwd: dataDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  coreState.proc = proc
  coreState.pid = proc.pid || 0

  const stamp = () => `[${new Date().toISOString()}] `
  proc.stdout.on('data', (chunk) => appendCoreLog(dataDir, stamp() + String(chunk).trimEnd() + '\n'))
  proc.stderr.on('data', (chunk) => appendCoreLog(dataDir, stamp() + '[err] ' + String(chunk).trimEnd() + '\n'))
  proc.on('error', (error) => {
    if (proc !== coreState.proc) return
    coreState.status = 'error'
    coreState.error = `核心进程启动失败：${error.message}`
    coreState.proc = null
  })
  proc.on('exit', (code, signal) => {
    if (proc !== coreState.proc) return
    coreState.proc = null
    coreState.pid = 0
    if (coreState.stopping) {
      coreState.status = 'stopped'
      return
    }
    coreState.status = 'error'
    coreState.error = `采集核心退出了（code=${code ?? 'null'} signal=${signal ?? 'null'}），去看日志。`
  })

  try {
    await waitCoreReady(base)
  } catch (error) {
    coreState.status = 'error'
    coreState.error = error?.message || String(error)
    try {
      proc.kill('SIGTERM')
    } catch {
      /* 已经退出 */
    }
    throw error
  }

  // 核心就绪后会写 discovery；读不到 key 就沿用文件里已有的。
  const record = readJsonFile(discoveryFile) || {}
  coreState.key = String(record.key || '')
  coreState.status = 'running'
  coreState.startedAt = Date.now()
  return coreStatus()
}

async function stopCore() {
  const proc = coreState.proc
  if (!proc) {
    coreState.status = 'stopped'
    coreState.pid = 0
    return coreStatus()
  }

  coreState.stopping = true
  coreState.status = 'stopping'

  try {
    if (platform() === 'win32') {
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true })
    } else {
      proc.kill('SIGTERM')
    }
  } catch {
    /* 已经退出 */
  }

  const deadline = Date.now() + 5000
  while (coreState.proc && Date.now() < deadline) await sleep(200)

  if (coreState.proc) {
    try {
      proc.kill('SIGKILL')
    } catch {
      /* 已经退出 */
    }
    coreState.proc = null
  }

  coreState.status = 'stopped'
  coreState.pid = 0
  coreState.base = ''
  coreState.key = ''
  return coreStatus()
}

/* ------------------------------------------------------------------ */
/* 调到采集核心                                                         */
/* ------------------------------------------------------------------ */

class WorkbenchError extends Error {
  constructor(message, code = 'WORKBENCH_ERROR') {
    super(message)
    this.name = 'WorkbenchError'
    this.code = code
  }
}

async function callCore(path, { method = 'GET', body, timeoutMs = 20000 } = {}) {
  const conn = resolveConnection()
  if (!conn) {
    throw new WorkbenchError(
      `没有找到正在运行的工蜂。请先打开工蜂客户端，并确认「设置 → 接口 → ① 本机档」已开启。` +
        `如果刚启动，稍等 2 秒重试；也可以把地址和钥匙写进 ${join(PACKAGE_DIR, 'config.json')}。`,
      'NOT_CONNECTED',
    )
  }

  let response
  try {
    response = await fetch(conn.base + path, {
      method,
      headers: {
        Authorization: `Bearer ${conn.key}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? '请求超时' : error?.message || String(error)
    throw new WorkbenchError(`连不上工蜂采集核心（${conn.base}）：${reason}`, 'CORE_UNREACHABLE')
  }

  const text = await response.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : {}
  } catch {
    payload = { ok: false, error: { code: 'BAD_RESPONSE', message: text.slice(0, 500) } }
  }

  if (!response.ok || payload?.ok === false) {
    const code = payload?.error?.code || `HTTP_${response.status}`
    const message = payload?.error?.message || `采集核心返回 ${response.status}`
    if (response.status === 401 || code === 'INVALID_KEY' || code === 'NO_KEY_CONFIGURED') {
      throw new WorkbenchError(
        `工蜂钥匙无效或接口档没开（${code}）。打开工蜂「设置 → 接口」，确认①本机档开启后重启工蜂。`,
        code,
      )
    }
    throw new WorkbenchError(message, code)
  }

  return payload
}

async function probe() {
  const conn = resolveConnection({ fresh: true })
  if (!conn) {
    return {
      ok: true,
      connected: false,
      base: '',
      source: '',
      devices: [],
      hint: discoveryHint(),
      core: coreStatus(),
      message: '没有找到正在运行的采集核心。启动核心，或打开工蜂客户端。',
    }
  }
  try {
    const payload = await callCore('/api/v1/xhs/devices', { timeoutMs: 8000 })
    return {
      ok: true,
      connected: true,
      base: conn.base,
      source: conn.source,
      pid: conn.pid,
      devices: Array.isArray(payload.devices) ? payload.devices : [],
      core: coreStatus(),
    }
  } catch (error) {
    // 老版本核心没有 /devices：用 /tasks 判断连通性，设备列表降级为空。
    try {
      await callCore('/api/v1/xhs/tasks?limit=1', { timeoutMs: 8000 })
      return {
        ok: true,
        connected: true,
        base: conn.base,
        source: conn.source,
        pid: conn.pid,
        devices: [],
        devicesUnsupported: true,
        core: coreStatus(),
      }
    } catch {
      return {
        ok: true,
        connected: false,
        base: conn.base,
        source: conn.source,
        devices: [],
        hint: discoveryHint(),
        core: coreStatus(),
        message: error?.message || String(error),
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 面板用的同源路由（钥匙只在 Host 手里）                                */
/* ------------------------------------------------------------------ */

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1024 * 1024) throw new WorkbenchError('请求体过大', 'PAYLOAD_TOO_LARGE')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : {}
}

const IMAGE_HOSTS = /(^|\.)(xiaohongshu\.com|xhscdn\.com|xiaohongshu\.net)$/i

async function proxyMedia(url, res) {
  const target = String(url || '')
  let parsed
  try {
    parsed = new URL(target)
  } catch {
    sendJson(res, 400, { ok: false, error: { code: 'BAD_URL', message: '图片地址不合法' } })
    return
  }
  if (!/^https?:$/.test(parsed.protocol) || !IMAGE_HOSTS.test(parsed.hostname)) {
    sendJson(res, 400, { ok: false, error: { code: 'BAD_URL', message: '只代理小红书图床地址' } })
    return
  }

  const conn = resolveConnection()
  if (!conn) {
    sendJson(res, 503, { ok: false, error: { code: 'NOT_CONNECTED', message: '工蜂没有运行' } })
    return
  }

  try {
    const upstream = await fetch(`${conn.base}/media?url=${encodeURIComponent(target)}`, {
      headers: { Authorization: `Bearer ${conn.key}` },
      signal: AbortSignal.timeout(30000),
    })
    if (!upstream.ok) {
      sendJson(res, 502, { ok: false, error: { code: 'MEDIA_FAILED', message: `图片缓存失败 ${upstream.status}` } })
      return
    }
    const buffer = Buffer.from(await upstream.arrayBuffer())
    res.writeHead(200, {
      'content-type': upstream.headers.get('content-type') || 'image/jpeg',
      'cache-control': 'public, max-age=86400',
    })
    res.end(buffer)
  } catch (error) {
    sendJson(res, 502, { ok: false, error: { code: 'MEDIA_FAILED', message: error?.message || String(error) } })
  }
}

async function handleRoute(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  let url
  try {
    url = new URL(req.url, 'http://127.0.0.1')
  } catch {
    sendJson(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: '请求地址不合法' } })
    return
  }

  const sub = url.pathname.slice(ROUTE_PREFIX.length) || '/'
  const method = req.method || 'GET'

  // 同源请求带一个自定义头，挡住其它网页对本机端口发起的跨站调用。
  // /media 例外：<img> 带不了自定义头，但它只代理小红书图床，且只读。
  if (sub !== '/media' && req.headers[CSRF_HEADER] !== '1') {
    sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: '缺少插件请求头' } })
    return
  }

  try {
    if (method === 'GET' && sub === '/status') {
      sendJson(res, 200, await probe())
      return
    }

    if (method === 'GET' && sub === '/core/status') {
      sendJson(res, 200, { ok: true, core: coreStatus() })
      return
    }

    if (method === 'POST' && sub === '/core/start') {
      sendJson(res, 200, { ok: true, core: await startCore() })
      return
    }

    if (method === 'POST' && sub === '/core/stop') {
      sendJson(res, 200, { ok: true, core: await stopCore() })
      return
    }

    if (method === 'GET' && sub === '/pools') {
      const [pools, totals] = await Promise.all([
        callCore('/api/pools', { timeoutMs: 15000 }),
        callCore('/api/pools/totals', { timeoutMs: 15000 }),
      ])
      sendJson(res, 200, { ok: true, pools: Array.isArray(pools.pools) ? pools.pools : [], totals })
      return
    }

    if (method === 'GET' && sub === '/pool/items') {
      const params = new URLSearchParams()
      for (const key of ['pool', 'status', 'q', 'sort', 'page', 'page_size', 'favorite_only']) {
        const value = url.searchParams.get(key)
        if (value !== null && value !== '') params.set(key, value)
      }
      sendJson(res, 200, await callCore(`/api/pools/items?${params.toString()}`, { timeoutMs: 20000 }))
      return
    }

    if (method === 'GET' && sub === '/pool/item') {
      const itemId = String(url.searchParams.get('item_id') || '').trim()
      if (!itemId) throw new WorkbenchError('缺少 item_id', 'BAD_REQUEST')
      sendJson(res, 200, await callCore(`/api/pools/item?item_id=${encodeURIComponent(itemId)}`, { timeoutMs: 20000 }))
      return
    }

    if (method === 'POST' && sub === '/pool/favorite') {
      const body = await readJsonBody(req)
      const itemId = String(body.item_id || '').trim()
      if (!itemId) throw new WorkbenchError('缺少 item_id', 'BAD_REQUEST')
      sendJson(
        res,
        200,
        await callCore('/api/pools/item/favorite', {
          method: 'POST',
          body: { item_id: itemId, favorite: Boolean(body.favorite) },
          timeoutMs: 15000,
        }),
      )
      return
    }

    if (method === 'GET' && sub === '/devices') {
      sendJson(res, 200, await callCore('/api/v1/xhs/devices', { timeoutMs: 8000 }))
      return
    }

    if (method === 'GET' && sub === '/tasks') {
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30))
      sendJson(res, 200, await callCore(`/api/v1/xhs/tasks?limit=${limit}`))
      return
    }

    if (method === 'GET' && sub === '/task') {
      const id = Number(url.searchParams.get('id'))
      if (!id) throw new WorkbenchError('缺少任务 id', 'BAD_REQUEST')
      sendJson(res, 200, await callCore(`/api/v1/xhs/tasks/${id}`, { timeoutMs: 15000 }))
      return
    }

    if (method === 'GET' && sub === '/result') {
      const id = Number(url.searchParams.get('id'))
      if (!id) throw new WorkbenchError('缺少任务 id', 'BAD_REQUEST')
      sendJson(res, 200, await callCore(`/api/v1/xhs/tasks/${id}/result`, { timeoutMs: 60000 }))
      return
    }

    if (method === 'GET' && sub === '/media') {
      await proxyMedia(url.searchParams.get('url'), res)
      return
    }

    if (method === 'POST' && sub === '/create') {
      const body = await readJsonBody(req)
      const input = String(body.input || '').trim()
      if (!input) throw new WorkbenchError('输入内容不能为空', 'BAD_REQUEST')
      const payload = {
        input,
        limit: Math.max(1, Math.min(500, Number(body.limit) || 20)),
      }
      if (body.task_type) payload.task_type = String(body.task_type)
      if (body.device_serial) payload.device_serial = String(body.device_serial)
      if (body.target) payload.target = String(body.target)
      if (body.options && typeof body.options === 'object') payload.options = body.options
      sendJson(res, 200, await callCore('/api/v1/xhs/tasks', { method: 'POST', body: payload, timeoutMs: 30000 }))
      return
    }

    if (method === 'POST' && sub === '/action') {
      const body = await readJsonBody(req)
      const id = Number(body.id)
      const action = String(body.action || '')
      if (!id) throw new WorkbenchError('缺少任务 id', 'BAD_REQUEST')
      if (!['cancel', 'retry'].includes(action)) throw new WorkbenchError('不支持的动作', 'BAD_REQUEST')
      sendJson(res, 200, await callCore(`/api/v1/xhs/tasks/${id}/${action}`, { method: 'POST', body: {}, timeoutMs: 20000 }))
      return
    }

    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '未知的面板接口' } })
  } catch (error) {
    const status = error instanceof WorkbenchError && error.code === 'NOT_CONNECTED' ? 503 : 400
    sendJson(res, status, {
      ok: false,
      error: { code: error?.code || 'ERROR', message: error?.message || String(error) },
    })
  }
}

/* ------------------------------------------------------------------ */
/* Agent 工具                                                          */
/* ------------------------------------------------------------------ */

const OBJECT_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render(_args, value) {
    return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  },
}

const TASK_TYPES = [
  'keyword',
  'goods_link',
  'shop_link',
  'shop_info',
  'goods_comments',
  'note_link',
  'creator_profile',
  'creator_notes',
  'note_comments',
  'creator_discovery',
  'matrix_creator_discovery',
  'root_keyword_search',
]

function defineTools() {
  return [
    {
      name: 'xhs_status',
      description:
        '检查工蜂采集核心是否在线，并返回连接地址、设备列表和在线/忙碌状态。' +
        '采集是异步的：先用本工具确认有可用手机，再用 xhs_create_task 建单。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: OBJECT_OUTPUT,
      async execute() {
        return probe()
      },
    },
    {
      name: 'xhs_devices',
      description: '列出工蜂能调度的安卓设备（名称、序列号、在线、是否正在采集）。建单需要 device_serial 时从这里取。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: OBJECT_OUTPUT,
      async execute() {
        try {
          return await callCore('/api/v1/xhs/devices', { timeoutMs: 8000 })
        } catch (error) {
          // 老版本核心没有设备端点；仍要告诉 Agent 核心是活的。
          if (String(error?.message || '').includes('Route not found')) {
            return { ok: true, devices: [], unsupported: true, message: '当前核心版本不提供设备列表；建单时会由执行器自动选机。' }
          }
          throw error
        }
      },
    },
    {
      name: 'xhs_create_task',
      description:
        '创建一个小红书异步采集任务。input 可以是关键词、商品链接、店铺链接、笔记链接或博主主页链接；' +
        'task_type 不传时由输入自动识别。创建后返回 task_id，用 xhs_task 轮询状态、xhs_result 取结果。' +
        `可用 task_type：${TASK_TYPES.join('、')}。`,
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: '关键词，或一条小红书链接（商品/店铺/笔记/博主主页）' },
          task_type: { type: 'string', enum: TASK_TYPES, description: '显式指定任务类型；不传则按输入自动识别' },
          limit: { type: 'integer', minimum: 1, maximum: 500, description: '目标条数，默认 20；单链接类模块固定为 1' },
          device_serial: { type: 'string', description: '指定执行手机序列号；不传由执行器自动选机' },
          target: { type: 'string', description: '矩阵号猎手的目标商家 ID 或店铺链接，仅 matrix_creator_discovery 用' },
        },
        required: ['input'],
        additionalProperties: false,
      },
      output: OBJECT_OUTPUT,
      async execute(args) {
        const payload = {
          input: String(args.input || '').trim(),
          limit: Math.max(1, Math.min(500, Number(args.limit) || 20)),
        }
        if (!payload.input) throw new WorkbenchError('input 不能为空', 'BAD_REQUEST')
        if (args.task_type) payload.task_type = String(args.task_type)
        if (args.device_serial) payload.device_serial = String(args.device_serial)
        if (args.target) payload.target = String(args.target)
        return callCore('/api/v1/xhs/tasks', { method: 'POST', body: payload, timeoutMs: 30000 })
      },
    },
    {
      name: 'xhs_task',
      description: '查询单个采集任务的状态、进度计数和完成原因。采集通常需要几十秒到几分钟，建议间隔 5–10 秒轮询。',
      parameters: {
        type: 'object',
        properties: { task_id: { type: 'integer', minimum: 1, description: '任务 ID' } },
        required: ['task_id'],
        additionalProperties: false,
      },
      output: OBJECT_OUTPUT,
      async execute(args) {
        const id = Number(args.task_id)
        if (!id) throw new WorkbenchError('task_id 不合法', 'BAD_REQUEST')
        return callCore(`/api/v1/xhs/tasks/${id}`, { timeoutMs: 15000 })
      },
    },
    {
      name: 'xhs_result',
      description:
        '取采集任务的 JSON 结果。商品类返回 records[]（商品/店铺/图片），笔记类返回 notes[]，' +
        '评论类返回 comments[]，店铺档案返回 shop_info，博主主页返回 creator_profile。只对已完成任务调用。',
      parameters: {
        type: 'object',
        properties: { task_id: { type: 'integer', minimum: 1, description: '任务 ID' } },
        required: ['task_id'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(args, value) {
          // 结果可能很大，模型正文只放摘要，完整 JSON 交给面板。
          const summary = {
            task_id: value?.task_id,
            task_type: value?.task_type,
            status: value?.status,
            completion_reason: value?.completion_reason,
            stats: value?.stats,
            records: Array.isArray(value?.records) ? value.records.length : 0,
            notes: Array.isArray(value?.notes) ? value.notes.length : 0,
            comments: Array.isArray(value?.comments) ? value.comments.length : 0,
          }
          return [{ type: 'text', text: JSON.stringify(summary, null, 2) }]
        },
      },
      async execute(args) {
        const id = Number(args.task_id)
        if (!id) throw new WorkbenchError('task_id 不合法', 'BAD_REQUEST')
        return callCore(`/api/v1/xhs/tasks/${id}/result`, { timeoutMs: 60000 })
      },
    },
    {
      name: 'xhs_pools',
      description: '列出所有行业机会池（每个池的关键词数、任务数、各状态商品数）和全库总量。AI 选品分析从这里开始。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: OBJECT_OUTPUT,
      async execute() {
        const [pools, totals] = await Promise.all([
          callCore('/api/pools', { timeoutMs: 15000 }),
          callCore('/api/pools/totals', { timeoutMs: 15000 }),
        ])
        return { ok: true, pools: Array.isArray(pools.pools) ? pools.pools : [], totals }
      },
    },
    {
      name: 'xhs_pool_items',
      description:
        '分页查询机会池商品。可按池、状态（all/confirmed/candidate/observed/rejected）、关键词搜索、收藏筛选，' +
        '并按 daily_revenue(日营业额)/total_revenue/cart(24小时加购)/sold/price/created_at 排序。' +
        '用于选品分析：先筛出候选，再逐个 xhs_pool_item 看详情。',
      parameters: {
        type: 'object',
        properties: {
          pool: { type: 'string', description: '池名称，空表示全部池' },
          status: { type: 'string', enum: ['all', 'confirmed', 'candidate', 'observed', 'rejected'], description: '入池状态，默认 all' },
          query: { type: 'string', description: '按商品名/店铺/关键词搜索' },
          sort: { type: 'string', description: '排序，形如 daily_revenue:desc，默认日营业额倒序' },
          page: { type: 'integer', minimum: 1, description: '页码，默认 1' },
          page_size: { type: 'integer', minimum: 1, maximum: 100, description: '每页条数，默认 20' },
          favorite_only: { type: 'boolean', description: '只看收藏' },
        },
        additionalProperties: false,
      },
      output: OBJECT_OUTPUT,
      async execute(args) {
        const params = new URLSearchParams()
        if (args.pool) params.set('pool', String(args.pool))
        if (args.status) params.set('status', String(args.status))
        if (args.query) params.set('q', String(args.query))
        if (args.sort) params.set('sort', String(args.sort))
        if (args.page) params.set('page', String(Number(args.page) || 1))
        if (args.page_size) params.set('page_size', String(Math.min(100, Number(args.page_size) || 20)))
        if (args.favorite_only) params.set('favorite_only', '1')
        return callCore(`/api/pools/items?${params.toString()}`, { timeoutMs: 20000 })
      },
    },
    {
      name: 'xhs_pool_item',
      description: '读取单个机会池商品的完整详情（图片、卖点标签、24小时加购命中、店铺、物流、复核信息）。',
      parameters: {
        type: 'object',
        properties: { item_id: { type: 'string', description: '商品 item_id' } },
        required: ['item_id'],
        additionalProperties: false,
      },
      output: OBJECT_OUTPUT,
      async execute(args) {
        const itemId = String(args.item_id || '').trim()
        if (!itemId) throw new WorkbenchError('item_id 不能为空', 'BAD_REQUEST')
        return callCore(`/api/pools/item?item_id=${encodeURIComponent(itemId)}`, { timeoutMs: 20000 })
      },
    },
    {
      name: 'xhs_cancel_task',
      description: '取消一个排队中或运行中的采集任务。',
      parameters: {
        type: 'object',
        properties: { task_id: { type: 'integer', minimum: 1, description: '任务 ID' } },
        required: ['task_id'],
        additionalProperties: false,
      },
      output: OBJECT_OUTPUT,
      async execute(args) {
        const id = Number(args.task_id)
        if (!id) throw new WorkbenchError('task_id 不合法', 'BAD_REQUEST')
        return callCore(`/api/v1/xhs/tasks/${id}/cancel`, { method: 'POST', body: {}, timeoutMs: 20000 })
      },
    },
  ]
}

/* ------------------------------------------------------------------ */
/* 插件入口                                                            */
/* ------------------------------------------------------------------ */

export const inject = ['tools']

export function apply(ctx) {
  for (const tool of defineTools()) {
    ctx.effect(() => ctx.tools.register(tool))
  }

  // webServer 是可选依赖：CLI / headless 组合里没有它，插件依然提供工具。
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() =>
      webCtx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: handleRoute,
      }),
    )
  })
}
