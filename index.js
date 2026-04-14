import plugin from '../../lib/plugins/plugin.js'
import fs from 'fs'
import path from 'path'
import YAML from 'yaml'

const PLUGIN_NAME = 'maimai-score-hub-plugin'
const PLUGIN_DIR = path.join(process.cwd(), 'plugins', PLUGIN_NAME)
const TOKEN_FILE = path.join(process.cwd(), 'data', PLUGIN_NAME, 'tokens.json')
const CONFIG_DIR = path.join(PLUGIN_DIR, 'config', 'config')
const DEFAULT_CONFIG_DIR = path.join(PLUGIN_DIR, 'config', 'default_config')
const IMG_CACHE_DIR = path.join(process.cwd(), 'data', PLUGIN_NAME, 'img_cache')
const API_TIMEOUT = 300000
const IMG_TIMEOUT = 300000

if (!fs.existsSync(path.dirname(TOKEN_FILE))) {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true })
}
if (!fs.existsSync(IMG_CACHE_DIR)) {
  fs.mkdirSync(IMG_CACHE_DIR, { recursive: true })
} else {
  try {
    const files = fs.readdirSync(IMG_CACHE_DIR)
    for (const f of files) {
      try { fs.unlinkSync(path.join(IMG_CACHE_DIR, f)) } catch {}
    }
  } catch {}
}

class Config {
  static _config = null

  static getConfig(name = 'config') {
    const configFile = path.join(CONFIG_DIR, `${name}.yaml`)
    const defaultFile = path.join(DEFAULT_CONFIG_DIR, `${name}.yaml`)

    if (!fs.existsSync(configFile)) {
      if (fs.existsSync(defaultFile)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true })
        fs.copyFileSync(defaultFile, configFile)
      } else {
        return {}
      }
    }

    try {
      return YAML.parse(fs.readFileSync(configFile, 'utf8')) || {}
    } catch {
      return {}
    }
  }

  static setConfig(name, data) {
    const configFile = path.join(CONFIG_DIR, `${name}.yaml`)
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
    fs.writeFileSync(configFile, YAML.stringify(data))
  }

  static get backendUrl() {
    const cfg = this.getConfig()
    return cfg.backendUrl || 'https://api.maiscorehub.bakapiano.com/api'
  }
}

async function getSyncBinding() {
  try {
    const module = await import('../maibot-plugin/model/db.js')
    const { MaibotDB } = module
    return {
      getUserBinding: MaibotDB.getUserBinding,
      setUserBinding: MaibotDB.setUserBinding
    }
  } catch {
    return null
  }
}

class TokenStore {
  static _data = null

  static _load() {
    if (this._data) return this._data
    if (!fs.existsSync(TOKEN_FILE)) {
      this._data = {}
      return this._data
    }
    try {
      this._data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'))
    } catch {
      this._data = {}
    }
    return this._data
  }

  static _save() {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true })
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(this._data, null, 2))
  }

  static get(userId) {
    return this._load()[userId] || null
  }

  static set(userId, token, friendCode) {
    this._load()[userId] = { token, friendCode }
    this._save()
  }

  static remove(userId) {
    this._load()
    delete this._data[userId]
    this._save()
  }
}

class ApiClient {
  static async fetch(url, options = {}) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), options.timeout || API_TIMEOUT)
    try {
      const response = await fetch(url, { ...options, signal: controller.signal })
      clearTimeout(timeout)
      const contentType = response.headers.get('content-type')
      if (contentType && contentType.includes('application/json')) {
        return { ok: response.ok, status: response.status, data: await response.json() }
      }
      if (contentType && (contentType.includes('image/') || contentType.includes('octet-stream'))) {
        const buffer = Buffer.from(await response.arrayBuffer())
        return { ok: response.ok, status: response.status, buffer, contentType }
      }
      const text = await response.text()
      if (!response.ok) {
        try {
          const data = JSON.parse(text)
          return { ok: false, status: response.status, data }
        } catch {}
        return { ok: false, status: response.status, error: text.slice(0, 200) || `HTTP ${response.status}` }
      }
      return { ok: true, status: response.status, text }
    } catch (error) {
      clearTimeout(timeout)
      if (error.name === 'AbortError') {
        return { ok: false, status: 0, error: '请求超时，请稍后重试' }
      }
      return { ok: false, status: 0, error: error.message }
    }
  }
}

const STAGE_MAP = {
  send_request: '📤 发送好友请求',
  wait_acceptance: '⏳ 等待同意好友',
  update_score: '📥 更新成绩中'
}

const JOB_TYPE_MAP = {
  immediate: '🔄 立即同步',
  idle_add_friend: '🤝 闲时添加好友',
  idle_update_score: '📥 闲时更新成绩'
}

const DIFF_NAMES = {
  0: 'Basic', 1: 'Advanced', 2: 'Expert', 3: 'Master', 4: 'Re:Master', 10: 'Utage'
}

const PLAN_MAP = {
  '将': 'jiang',
  '极': 'ji',
  '舞': 'wuwu',
  '神': 'shen'
}

export class MaimaiScoreHub extends plugin {
  constructor() {
    super({
      name: 'MaimaiScoreHub',
      dsc: 'Maimai Score Hub 交互插件',
      event: 'message',
      priority: 5000,
      rule: [
        {
          reg: '^#knd$',
          fnc: 'dashboard'
        },
        {
          reg: '^#knd\\s*bind\\s*(.+)$',
          fnc: 'bind'
        },
        {
          reg: '^#knd\\s*解绑$',
          fnc: 'unbind'
        },
        {
          reg: '^#knd\\s*sync$',
          fnc: 'sync'
        },
        {
          reg: '^#knd\\s*info$',
          fnc: 'info'
        },
        {
          reg: '^#knd\\s*状态$',
          fnc: 'jobStatus'
        },
        {
          reg: '^#knd\\s*绑定水鱼账号\\s*(\\S+)\\s+(\\S+)$',
          fnc: 'bindDivingFishAccount'
        },
        {
          reg: '^#knd\\s*绑定(水鱼|落雪)\\s*(.+)$',
          fnc: 'setToken'
        },
        {
          reg: '^#knd\\s*更新(水鱼|落雪)$',
          fnc: 'exportData'
        },
        {
          reg: '^#knd\\s*更新全部$',
          fnc: 'exportAll'
        },
        {
          reg: '^(导|ccb)$',
          fnc: 'autoExportToBound'
        },
        {
          reg: '^#knd\\s*闲时(更新开|更新关|状态)$',
          fnc: 'idleUpdate'
        },
        {
          reg: '^#knd\\s*自动导出(水鱼|落雪)(开|关)$',
          fnc: 'autoExport'
        },
        {
          reg: '^#knd\\s*(sync\\s*)?help$',
          fnc: 'help'
        },
        {
          reg: '^水鱼帮助$',
          fnc: 'divingFishHelp'
        },
        {
          reg: '^落雪帮助$',
          fnc: 'lxnsHelp'
        },
        {
          reg: '^#knd\\s*设置后端\\s*(.+)$',
          fnc: 'setBackend',
          permission: 'master'
        }
      ]
    })
  }

  get api() {
    return Config.backendUrl
  }

  requireAuth(e) {
    const userData = TokenStore.get(e.user_id)
    if (!userData) {
      e.reply(
        `⚠️ 您还未绑定好友代码\n\n` +
        `📌 快速开始:\n` +
        `1️⃣ 在舞萌DX公众号 → 好友 → 查看你的好友号码\n` +
        `2️⃣ 发送 #knd bind <好友代码>\n\n` +
        `例如: #knd bind 1234567890123`
      )
      return null
    }
    return userData
  }

  handleAuthError(res, e) {
    if (res.status === 401) {
      TokenStore.remove(e.user_id)
      e.reply(
        `❌ 授权已过期\n\n` +
        `请重新绑定: #knd bind <好友代码>`
      )
      return true
    }
    return false
  }

  async safeRecall(e, messageId) {
    try {
      if (e.group?.recallMsg && messageId) {
        await e.group.recallMsg(messageId)
      }
    } catch {}
  }

  async recallAndReply(e, msgId, msg) {
    if (msgId) await this.safeRecall(e, msgId)
    await e.reply(msg)
  }

  async jobStatus(e) {
    const userData = this.requireAuth(e)
    if (!userData) return

    if (!userData) {
      await e.reply(
        `🎵 Maimai Score Hub\n\n` +
        `⚠️ 您还未绑定好友代码\n\n` +
        `📌 快速开始:\n` +
        `1️⃣ 在舞萌DX公众号 → 好友 → 查看你的好友号码\n` +
        `2️⃣ 发送 #knd bind <好友代码>\n` +
        `3️⃣ 绑定成功后即可同步成绩\n\n` +
        `💡 发送 #knd help 查看完整命令列表`
      )
      return
    }

    const res = await ApiClient.fetch(`${this.api}/users/profile`, {
      headers: { 'Authorization': `Bearer ${userData.token}` },
      timeout: 10000
    })

    if (!res.ok) {
      if (res.status === 401) {
        TokenStore.remove(e.user_id)
        await e.reply(
          `🎵 Maimai Score Hub\n\n` +
          `❌ 授权已过期，请重新绑定\n` +
          `#knd bind <好友代码>`
        )
        return
      }
      await e.reply(
        `🎵 Maimai Score Hub\n\n` +
        `👤 好友代码: ${userData.friendCode}\n` +
        `⚠️ 无法连接服务器，请稍后重试`
      )
      return
    }

    const profile = res.data
    let msg = `🎵 Maimai Score Hub\n\n`
    msg += `👤 好友代码: ${profile.friendCode}\n`

    const dfStatus = profile.hasDivingFishImportToken ? '✅' : '❌'
    const lxnsStatus = profile.hasLxnsImportToken ? '✅' : '❌'
    msg += `🔗 水鱼: ${dfStatus}  落雪: ${lxnsStatus}\n`

    if (profile.idleUpdateBotFriendCode) {
      msg += `🤖 闲时更新: ✅\n`
    }

    msg += `\n📌 常用命令:\n`
    msg += `  #knd sync    同步成绩\n`
    msg += `  导/ccb  导出到已绑定平台\n`
    msg += `  #knd 状态    查看任务进度\n`
    msg += `  #knd help    完整命令列表`

    await e.reply(msg)
  }

  async bind(e) {
    const friendCode = e.msg.replace(/^#knd\s*bind\s*/, '').trim()
    if (!friendCode) {
      await e.reply(
        `⚠️ 请输入好友代码\n\n` +
        `📌 获取方式:\n` +
        `舞萌DX公众号 → 好友 → 你的好友号码\n\n` +
        `用法: #knd bind <好友代码>\n` +
        `例如: #knd bind 1234567890123`
      )
      return
    }

    const msg1 = await e.reply(`🔄 正在请求绑定好友代码: ${friendCode}...`)

    const reqRes = await ApiClient.fetch(`${this.api}/auth/login-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ friendCode, skipUpdateScore: true })
    })

    if (!reqRes.ok) {
      const errMsg = reqRes.data?.message || reqRes.error || '未知错误'
      let tip = ''
      if (errMsg.includes('already') || errMsg.includes('已')) {
        tip = '\n\n💡 如果已绑定过，可直接使用 #knd sync 同步成绩'
      }
      await this.recallAndReply(e, msg1?.message_id, `❌ 绑定失败: ${errMsg}${tip}`)
      return
    }

    if (reqRes.data.skipAuth) {
      TokenStore.set(e.user_id, reqRes.data.token, reqRes.data.user.friendCode)
      
      // 检查用户是否已绑定平台
      const profileRes = await ApiClient.fetch(`${this.api}/users/profile`, {
        headers: { 'Authorization': `Bearer ${reqRes.data.token}` }
      })
      
      let msg = `✅ 绑定成功！\n\n` +
        `👤 好友代码: ${reqRes.data.user.friendCode}\n\n`
      
      if (profileRes.ok) {
        const profile = profileRes.data
        const hasAnyBinding = profile.hasDivingFishImportToken || profile.hasLxnsImportToken
        
        if (!hasAnyBinding) {
          msg += `📌 下一步:\n` +
            `1️⃣ #knd 绑定水鱼 <Token> — 让机器人可以帮你把成绩上传到水鱼查分器\n` +
            `   （不知道水鱼查分器是什么？怎么找到token？怎么正确设置水鱼？请发送水鱼帮助获取提示）\n` +
            `2️⃣ #knd 绑定落雪 <api key> — 让机器人可以帮你把成绩上传到落雪查分器\n` +
            `   （不知道落雪查分器是什么？怎么找到api key？怎么正确设置落雪？请发送落雪帮助获取提示）`
        } else {
          msg += `📌 下一步:\n` +
            `1️⃣ #knd sync — 同步你的游戏成绩\n` +
            `2️⃣ 导/ccb — 导出到已绑定平台`
        }
      } else {
        msg += `📌 下一步:\n` +
          `1️⃣ #knd sync — 同步你的游戏成绩\n` +
          `2️⃣ #knd 绑定水鱼 <Token> — 设置导出平台\n` +
          `3️⃣ 导/ccb — 导出到已绑定平台`
      }
      
      await this.recallAndReply(e, msg1?.message_id, msg)
      return
    }

    const { jobId } = reqRes.data
    const msg2 = await e.reply(
      `📋 绑定请求已提交 (Job: ${jobId.slice(-6)})\n\n` +
      `⏳ 系统正在处理，请稍候...`
    )
    let acceptanceNotified = false
    let polling = true

    const startTime = Date.now()
    const timeout = 120 * 1000
    const interval = 3000

    const poll = async () => {
      if (!polling) return
      if (Date.now() - startTime > timeout) {
        polling = false
        await e.reply(
          `⏰ 绑定超时\n\n` +
          `可能原因:\n` +
          `• Worker 服务未启动\n` +
          `• 网络连接不稳定\n\n` +
          `请稍后重试: #knd bind ${friendCode}`
        )
        return
      }

      const statusRes = await ApiClient.fetch(`${this.api}/auth/login-status?jobId=${jobId}`)
      if (!statusRes.ok) {
        if (polling) setTimeout(poll, interval)
        return
      }

      const { status, token, user, job } = statusRes.data

      if (token) {
        polling = false
        await this.safeRecall(e, msg1?.message_id)
        await this.safeRecall(e, msg2?.message_id)
        TokenStore.set(e.user_id, token, user.friendCode)

        // 检查用户是否已绑定平台
        const profileRes = await ApiClient.fetch(`${this.api}/users/profile`, {
          headers: { 'Authorization': `Bearer ${token}` }
        })

        let msg = `✅ 绑定成功！\n\n👤 好友代码: ${user.friendCode}\n`
        if (status === 'processing') {
          msg += `\n📥 成绩更新仍在进行中，可使用 #knd 状态 查看进度\n`
        }

        if (profileRes.ok) {
          const profile = profileRes.data
          const hasAnyBinding = profile.hasDivingFishImportToken || profile.hasLxnsImportToken
          
          if (!hasAnyBinding) {
            msg += `\n📌 下一步:\n` +
              `1️⃣ #knd 绑定水鱼 <Token> — 让机器人可以帮你把成绩上传到水鱼查分器\n` +
              `   （不知道水鱼查分器是什么？怎么找到token？怎么正确设置水鱼？请发送水鱼帮助获取提示）\n` +
              `2️⃣ #knd 绑定落雪 <api key> — 让机器人可以帮你把成绩上传到落雪查分器\n` +
              `   （不知道落雪查分器是什么？怎么找到api key？怎么正确设置落雪？请发送落雪帮助获取提示）`
          } else {
            msg += `\n📌 下一步:\n` +
              `1️⃣ #knd sync — 同步你的游戏成绩\n` +
              `2️⃣ 导/ccb — 导出到已绑定平台`
          }
        } else {
          msg += `\n📌 下一步:\n` +
            `1️⃣ #knd sync — 同步你的游戏成绩\n` +
            `2️⃣ #knd 绑定水鱼 <Token> — 设置导出平台\n` +
            `3️⃣ 导/ccb — 导出到已绑定平台`
        }

        await e.reply(msg)
      } else if (status === 'failed' || status === 'canceled') {
        polling = false
        await e.reply(
          `❌ 绑定失败\n\n` +
          `原因: ${job?.error || '未知错误'}\n\n` +
          `请稍后重试: #knd bind ${friendCode}`
        )
      } else if (job?.stage === 'wait_acceptance' && !acceptanceNotified) {
        acceptanceNotified = true
        await e.reply(
          `⏳ 请到舞萌DX公众号同意最近一次的好友申请\n\n` +
          `💡 操作路径: 微信 → 舞萌DX公众号 → 好友 → 好友申请`
        )
        if (polling) setTimeout(poll, interval)
      } else {
        if (polling) setTimeout(poll, interval)
      }
    }
    setTimeout(poll, interval)
  }

  async unbind(e) {
    const userData = TokenStore.get(e.user_id)
    if (!userData) {
      await e.reply('⚠️ 您当前没有绑定记录')
      return
    }
    TokenStore.remove(e.user_id)
    await e.reply(
      `✅ 已解绑好友代码: ${userData.friendCode}\n\n` +
      `如需重新绑定: #knd bind <好友代码>`
    )
  }

  async sync(e) {
    const userData = this.requireAuth(e)
    if (!userData) return

    const msg1 = await e.reply('🔄 正在创建同步任务...')

    const res = await ApiClient.fetch(`${this.api}/job/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${userData.token}`
      },
      body: JSON.stringify({ friendCode: userData.friendCode })
    })

    if (!res.ok) {
      if (this.handleAuthError(res, e)) return
      const errMsg = res.data?.message || res.error
      let tip = ''
      if (errMsg.includes('active') || errMsg.includes('进行中')) {
        tip = '\n\n💡 可使用 #knd 状态 查看当前任务进度'
      }
      await this.recallAndReply(e, msg1?.message_id, `❌ 同步请求失败: ${errMsg}${tip}`)
      return
    }

    await this.safeRecall(e, msg1?.message_id)

    const { jobId } = res.data
    const msg2 = await e.reply(
      `📋 同步任务已创建 (Job: ${jobId.slice(-6)})\n\n` +
      `⏳ 系统正在处理...\n` +
      `如需同意好友申请，请到舞萌DX公众号操作`
    )

    let lastStage = null
    let lastProgressMsg = null
    let polling = true

    const startTime = Date.now()
    const timeout = 600 * 1000 // 10分钟超时
    const interval = 3000

    const poll = async () => {
      if (!polling) return
      if (Date.now() - startTime > timeout) {
        polling = false
        await e.reply(
          `⏰ 同步超时（10分钟）\n\n` +
          `可使用 #knd 状态 查看任务是否仍在进行`
        )
        return
      }

      const jobRes = await ApiClient.fetch(`${this.api}/job/${jobId}`, {
        headers: { 'Authorization': `Bearer ${userData.token}` }
      })
      if (!jobRes.ok) {
        if (polling) setTimeout(poll, interval)
        return
      }

      const jobData = jobRes.data

      if (jobData.stage && jobData.stage !== lastStage) {
        lastStage = jobData.stage
        if (jobData.stage === 'wait_acceptance') {
          await e.reply(
            `⏳ 等待您同意好友申请...\n\n` +
            `💡 操作路径: 微信 → 舞萌DX公众号 → 好友 → 接受中`
          )
        } else if (jobData.stage === 'update_score') {
          await this.safeRecall(e, msg2?.message_id)
          await e.reply('📥 正在从官网抓取成绩，请稍候...')
        }
      }

      if (jobData.status === 'completed') {
        polling = false

        let msg = '✅ 同步成功！'

        if (jobData.updateScoreDuration) {
          const sec = Math.round(jobData.updateScoreDuration / 1000)
          msg += ` (耗时 ${sec}秒)`
        }

        if (jobData.autoExportResult) {
          const parts = []
          if (jobData.autoExportResult.divingFish) {
            const df = jobData.autoExportResult.divingFish
            parts.push(`  水鱼: ${df.status === 'success' ? '✅' : '❌'} ${df.message || ''}`)
          }
          if (jobData.autoExportResult.lxns) {
            const lx = jobData.autoExportResult.lxns
            parts.push(`  落雪: ${lx.status === 'success' ? '✅' : '❌'} ${lx.message || ''}`)
          }
          if (parts.length > 0) {
            msg += '\n\n📤 自动导出结果:\n' + parts.join('\n')
          }
        }

        msg += '\n\n📌 接下来你可以:\n'
        msg += '  导/ccb — 导出到已绑定平台\n'
        msg += '  #knd 更新水鱼 — 导出到水鱼查分器\n'
        msg += '  #knd 更新落雪 — 导出到落雪查分器'

        await e.reply(msg, true)
      } else if (jobData.status === 'failed' || jobData.status === 'canceled') {
        polling = false
        let tip = ''
        if (jobData.error?.includes('friend') || jobData.error?.includes('好友')) {
          tip = '\n\n💡 请确保已在舞萌DX公众号同意好友申请'
        } else if (jobData.error?.includes('cookie') || jobData.error?.includes('Cookie')) {
          tip = '\n\n💡 Bot Cookie 可能已过期，请联系管理员'
        }
        await e.reply(`❌ 同步失败: ${jobData.error || '未知错误'}${tip}`)
      } else {
        if (polling) setTimeout(poll, interval)
      }
    }
    setTimeout(poll, interval)
  }

  async info(e) {
    const userData = this.requireAuth(e)
    if (!userData) return

    const res = await ApiClient.fetch(`${this.api}/users/profile`, {
      headers: { 'Authorization': `Bearer ${userData.token}` }
    })

    if (!res.ok) {
      if (this.handleAuthError(res, e)) return
      await e.reply(`❌ 获取信息失败: ${res.data?.message || res.error}`)
      return
    }

    const profile = res.data
    let msg = `👤 个人信息\n\n`
    msg += `好友代码: ${profile.friendCode}\n\n`

    msg += `🔗 导出平台:\n`
    msg += `  水鱼: ${profile.hasDivingFishImportToken ? '✅ 已绑定' : '❌ 未绑定'}\n`
    msg += `  落雪: ${profile.hasLxnsImportToken ? '✅ 已绑定' : '❌ 未绑定'}\n\n`

    msg += `📤 自动导出:\n`
    msg += `  水鱼: ${profile.autoExportDivingFish ? '✅ 已开启' : '❌ 已关闭'}\n`
    msg += `  落雪: ${profile.autoExportLxns ? '✅ 已开启' : '❌ 已关闭'}\n\n`

    msg += `🤖 闲时更新: `
    if (profile.idleUpdateBotFriendCode) {
      msg += `✅ 已开启 (Bot: ${profile.idleUpdateBotFriendCode})`
    } else {
      msg += `❌ 未开启\n💡 发送 #knd 闲时更新开 开启自动更新`
    }

    await e.reply(msg)
  }

  async jobStatus(e) {
    const userData = this.requireAuth(e)
    if (!userData) return

    const res = await ApiClient.fetch(`${this.api}/job/by-friend-code/${userData.friendCode}/active`, {
      headers: { 'Authorization': `Bearer ${userData.token}` }
    })

    if (!res.ok) {
      if (this.handleAuthError(res, e)) return
      await e.reply(`❌ 查询失败: ${res.data?.message || res.error}`)
      return
    }

    const { job } = res.data
    if (!job) {
      await e.reply(
        `📋 当前没有进行中的任务\n\n` +
        `💡 发送 #knd sync 开始同步成绩`
      )
      return
    }

    let msg = `📋 任务状态\n\n`
    msg += `类型: ${JOB_TYPE_MAP[job.jobType] || job.jobType}\n`
    msg += `状态: ${job.status}\n`
    msg += `阶段: ${STAGE_MAP[job.stage] || job.stage}\n`

    if (job.scoreProgress) {
      const { completedDiffs, totalDiffs } = job.scoreProgress
      const completed = completedDiffs.map(d => DIFF_NAMES[d] || d).join(' → ')
      const pct = Math.round((completedDiffs.length / totalDiffs) * 100)
      const bar = '█'.repeat(Math.floor(pct / 10)) + '░'.repeat(10 - Math.floor(pct / 10))
      msg += `\n📊 进度: [${bar}] ${pct}%\n`
      msg += `✅ ${completed}`
    }

    if (job.error) {
      msg += `\n\n❌ 错误: ${job.error}`
    }

    await e.reply(msg)
  }



  async exportData(e) {
    const match = e.msg.match(/^#knd\s*更新(水鱼|落雪)$/)
    if (!match) return
    const platform = match[1] === '水鱼' ? 'df' : 'lxns'

    const userData = this.requireAuth(e)
    if (!userData) return

    const endpoint = platform === 'df' ? 'diving-fish' : 'lxns'
    const platformName = match[1]

    const processingMsg = await e.reply(`📤 正在导出数据到${platformName}...`)

    const res = await ApiClient.fetch(`${this.api}/sync/latest/${endpoint}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${userData.token}` }
    })

    await this.safeRecall(e, processingMsg?.message_id)

    if (!res.ok) {
      if (this.handleAuthError(res, e)) return
      let tip = ''
      if (res.data?.message?.includes('token') || res.data?.message?.includes('Token')) {
        tip = `\n\n💡 请先绑定${platformName}Token: #knd 绑定${platformName} <Token>`
      } else if (res.data?.message?.includes('sync') || res.data?.message?.includes('同步')) {
        tip = '\n\n💡 请先同步成绩: #knd sync'
      }
      await e.reply(`❌ 导出${platformName}失败: ${res.data?.message || res.error}${tip}`, true)
      return
    }

    const data = res.data
    let msg = `✅ 更新${platformName}成功！\n`

    if (data.exported !== undefined) {
      msg += `📊 共导出: ${data.exported} 首\n`
    }
    if (data.scores !== undefined) {
      msg += `🎵 成绩数: ${data.scores}\n`
    }
    if (data.response) {
      const parts = []
      if (data.response.creates !== undefined) parts.push(`新增: ${data.response.creates}`)
      if (data.response.updates !== undefined) parts.push(`更新: ${data.response.updates}`)
      if (parts.length > 0) msg += `📝 ${parts.join(', ')}`
    }

    await e.reply(msg.trim(), true)
  }

  async exportAll(e) {
    const userData = this.requireAuth(e)
    if (!userData) return

    const processingMsg = await e.reply('📤 正在导出数据到水鱼和落雪...')

    const [dfRes, lxnsRes] = await Promise.all([
      ApiClient.fetch(`${this.api}/sync/latest/diving-fish`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${userData.token}` }
      }),
      ApiClient.fetch(`${this.api}/sync/latest/lxns`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${userData.token}` }
      })
    ])

    await this.safeRecall(e, processingMsg?.message_id)

    let msg = '📤 导出结果\n\n'

    if (dfRes.ok) {
      const d = dfRes.data
      msg += `🐟 水鱼: ✅ 成功\n`
      if (d.exported !== undefined) msg += `   导出: ${d.exported}首\n`
      if (d.scores !== undefined) msg += `   成绩: ${d.scores}条\n`
    } else {
      const err = dfRes.data?.message || dfRes.error
      let tip = ''
      if (err?.includes('token') || err?.includes('Token')) {
        tip = ' (未绑定Token)'
      }
      msg += `🐟 水鱼: ❌ 失败${tip}\n`
    }

    if (lxnsRes.ok) {
      const d = lxnsRes.data
      msg += `❄️ 落雪: ✅ 成功\n`
      if (d.exported !== undefined) msg += `   导出: ${d.exported}首\n`
      if (d.scores !== undefined) msg += `   成绩: ${d.scores}条\n`
    } else {
      const err = lxnsRes.data?.message || lxnsRes.error
      let tip = ''
      if (err?.includes('token') || err?.includes('Token')) {
        tip = ' (未绑定Token)'
      }
      msg += `❄️ 落雪: ❌ 失败${tip}\n`
    }

    await e.reply(msg.trim(), true)
  }

  async autoExportToBound(e) {
    const userData = this.requireAuth(e)
    if (!userData) return

    const processingMsg = await e.reply('🔄 正在同步成绩...')

    // 1. 先创建同步任务
    const syncRes = await ApiClient.fetch(`${this.api}/job/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${userData.token}`
      },
      body: JSON.stringify({ friendCode: userData.friendCode })
    })

    if (!syncRes.ok) {
      await this.safeRecall(e, processingMsg?.message_id)
      if (this.handleAuthError(syncRes, e)) return
      const errMsg = syncRes.data?.message || syncRes.error
      let tip = ''
      if (errMsg.includes('active') || errMsg.includes('进行中')) {
        tip = '\n\n💡 可使用 #knd 状态 查看当前任务进度'
      }
      await e.reply(`❌ 同步请求失败: ${errMsg}${tip}`)
      return
    }

    await this.safeRecall(e, processingMsg?.message_id)
    const { jobId } = syncRes.data
    const syncMsg = await e.reply(
      `📋 同步任务已创建 (Job: ${jobId.slice(-6)})\n\n` +
      `⏳ 正在同步成绩，请稍候...`
    )

    // 2. 等待同步完成
    let polling = true
    let syncSuccess = false
    let syncError = null
    let lastStage = null

    const startTime = Date.now()
    const timeout = 600 * 1000 // 10分钟超时
    const interval = 3000

    const pollSync = async () => {
      if (!polling) return
      if (Date.now() - startTime > timeout) {
        polling = false
        syncError = '同步超时（10分钟）'
        return
      }

      const jobRes = await ApiClient.fetch(`${this.api}/job/${jobId}`, {
        headers: { 'Authorization': `Bearer ${userData.token}` }
      })
      if (!jobRes.ok) {
        if (polling) setTimeout(pollSync, interval)
        return
      }

      const jobData = jobRes.data

      // 好友申请提醒
      if (jobData.stage && jobData.stage !== lastStage) {
        lastStage = jobData.stage
        if (jobData.stage === 'wait_acceptance') {
          await e.reply(
            `⏳ 等待您同意好友申请...\n\n` +
            `💡 操作路径: 微信 → 舞萌DX公众号 → 好友 → 好友申请`
          )
        } else if (jobData.stage === 'update_score') {
          await this.safeRecall(e, syncMsg?.message_id)
          await e.reply('📥 正在从官网抓取成绩，请稍候...')
        }
      }

      if (jobData.status === 'completed') {
        polling = false
        syncSuccess = true
      } else if (jobData.status === 'failed' || jobData.status === 'canceled') {
        polling = false
        syncError = jobData.error || '同步失败'
      } else {
        if (polling) setTimeout(pollSync, interval)
      }
    }

    await new Promise(resolve => {
      const intervalId = setInterval(() => {
        if (!polling) {
          clearInterval(intervalId)
          resolve()
        }
      }, 1000)
      pollSync()
    })

    await this.safeRecall(e, syncMsg?.message_id)

    if (!syncSuccess) {
      await e.reply(`❌ ${syncError || '同步失败'}`)
      return
    }

    // 3. 同步成功后，检查并导出到已绑定平台
    const exportMsg = await e.reply('📤 正在检查并导出到已绑定平台...')

    const profileRes = await ApiClient.fetch(`${this.api}/users/profile`, {
      headers: { 'Authorization': `Bearer ${userData.token}` }
    })

    if (!profileRes.ok) {
      await this.safeRecall(e, exportMsg?.message_id)
      if (this.handleAuthError(profileRes, e)) return
      await e.reply(`❌ 获取用户信息失败: ${profileRes.data?.message || profileRes.error}`)
      return
    }

    const profile = profileRes.data
    const exports = []

    if (profile.hasDivingFishImportToken) {
      exports.push({ platform: 'df', name: '水鱼' })
    }
    if (profile.hasLxnsImportToken) {
      exports.push({ platform: 'lxns', name: '落雪' })
    }

    if (exports.length === 0) {
      await this.safeRecall(e, exportMsg?.message_id)
      await e.reply('⚠️ 您尚未绑定任何导出平台\n\n' +
        '请先绑定:\n' +
        '  #knd 绑定水鱼 <Token>\n' +
        '  #knd 绑定落雪 <API Key>', true)
      return
    }

    // 4. 导出到所有已绑定平台
    const promises = exports.map(async (exp) => {
      const endpoint = exp.platform === 'df' ? 'diving-fish' : 'lxns'
      const res = await ApiClient.fetch(`${this.api}/sync/latest/${endpoint}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${userData.token}` }
      })
      return { ...exp, res }
    })

    const results = await Promise.all(promises)
    await this.safeRecall(e, exportMsg?.message_id)

    let msg = '✅ 同步成功！\n\n📤 导出结果\n\n'
    for (const result of results) {
      if (result.res.ok) {
        const d = result.res.data
        msg += `${result.platform === 'df' ? '🐟' : '❄️'} ${result.name}: ✅ 成功\n`
        if (d.exported !== undefined) msg += `   导出: ${d.exported}首\n`
        if (d.scores !== undefined) msg += `   成绩: ${d.scores}条\n`
      } else {
        const err = result.res.data?.message || result.res.error
        msg += `${result.platform === 'df' ? '🐟' : '❄️'} ${result.name}: ❌ 失败 - ${err}\n`
      }
    }

    await e.reply(msg.trim(), true)
  }

  async setToken(e) {
    const match = e.msg.match(/^#knd\s*绑定(水鱼|落雪)\s*(.+)$/)
    if (!match) return

    const platform = match[1] === '水鱼' ? 'df' : 'lxns'
    const tokenInput = match[2].trim()
    const userData = this.requireAuth(e)
    if (!userData) return

    const platformName = match[1]
    const processingMsg = await e.reply(`🔗 正在绑定${platformName}Token...`)

    const body = {}
    if (platform === 'df') {
      body.divingFishImportToken = tokenInput
    } else {
      body.lxnsImportToken = tokenInput
    }

    const res = await ApiClient.fetch(`${this.api}/users/profile`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${userData.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })

    await this.safeRecall(e, processingMsg?.message_id)

    if (!res.ok) {
      if (this.handleAuthError(res, e)) return
      await e.reply(`❌ 绑定${platformName}失败: ${res.data?.message || res.error}`, true)
      return
    }

    await e.reply(
      `✅ 绑定${platformName}成功！\n\n` +
      `📌 接下来:\n` +
      `• #knd sync — 先同步成绩\n` +
      `• #knd 更新${platformName} — 导出到${platformName}`
    , true)

    
    const SyncBinding = await this.getSyncBinding()
    if (SyncBinding) {
      SyncBinding.syncBinding(e.user_id.toString(), platform === 'df' ? 'fish' : 'lxns', tokenInput, 'maimaiScoreHub').catch(err => {
        logger.warn('[maimai-score-hub] 同步到 maibot 失败:', err)
      })
    }

    try {
      if (e.group?.recallMsg) {
        await e.group.recallMsg(e.message_id)
      }
    } catch {}
  }

  async bindDivingFishAccount(e) {
    const match = e.msg.match(/^#knd\s*绑定水鱼账号\s*(\S+)\s+(\S+)$/)
    if (!match) return

    const username = match[1]
    const password = match[2]
    const userData = this.requireAuth(e)
    if (!userData) return

    const processingMsg = await e.reply('🔗 正在通过水鱼账号获取Token...')

    const tokenRes = await ApiClient.fetch(`${this.api}/users/diving-fish/token`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${userData.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ username, password })
    })

    if (!tokenRes.ok) {
      await this.safeRecall(e, processingMsg?.message_id)
      if (this.handleAuthError(tokenRes, e)) return
      await e.reply(
        `❌ 获取水鱼Token失败: ${tokenRes.data?.message || tokenRes.error}\n\n` +
        `💡 请检查用户名和密码是否正确`
      , true)
      return
    }

    const importToken = tokenRes.data.importToken
    if (!importToken) {
      await this.safeRecall(e, processingMsg?.message_id)
      await e.reply('❌ 获取水鱼Token失败: 未返回importToken', true)
      return
    }

    const updateRes = await ApiClient.fetch(`${this.api}/users/profile`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${userData.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ divingFishImportToken: importToken })
    })

    await this.safeRecall(e, processingMsg?.message_id)

    if (!updateRes.ok) {
      if (this.handleAuthError(updateRes, e)) return
      await e.reply(`❌ 绑定水鱼Token失败: ${updateRes.data?.message || updateRes.error}`, true)
      return
    }

    await e.reply(
      `✅ 通过水鱼账号绑定成功！\n\n` +
      `📌 接下来:\n` +
      `• #knd sync — 先同步成绩\n` +
      `• #knd 更新水鱼 — 导出到水鱼`
    , true)

    try {
      if (e.group?.recallMsg) {
        await e.group.recallMsg(e.message_id)
      }
    } catch {}
  }

  async idleUpdate(e) {
    const match = e.msg.match(/^#knd\s*闲时(更新开|更新关|状态)$/)
    if (!match) return

    const action = match[1]
    const userData = this.requireAuth(e)
    if (!userData) return

    if (action === '状态') {
      const res = await ApiClient.fetch(`${this.api}/users/idle-update/status`, {
        headers: { 'Authorization': `Bearer ${userData.token}` }
      })

      if (!res.ok) {
        if (this.handleAuthError(res, e)) return
        await e.reply(`❌ 查询失败: ${res.data?.message || res.error}`)
        return
      }

      const data = res.data
      let msg = `🤖 闲时更新状态\n\n`
      msg += `已开启: ${data.enabled ? '✅' : '❌'}\n`
      if (data.botFriendCode) {
        msg += `分配Bot: ${data.botFriendCode}\n`
      }
      msg += `等待中任务: ${data.pendingJob ? '✅ 有' : '❌ 无'}\n`

      if (data.activeJob) {
        msg += `\n📋 当前任务:\n`
        msg += `  状态: ${data.activeJob.status}\n`
        msg += `  阶段: ${STAGE_MAP[data.activeJob.stage] || data.activeJob.stage}`
      }

      if (!data.enabled) {
        msg += `\n\n💡 发送 #knd 闲时更新开 开启自动更新`
      }

      await e.reply(msg)
      return
    }

    const endpoint = action === '更新开' ? 'enable' : 'disable'
    const res = await ApiClient.fetch(`${this.api}/users/idle-update/${endpoint}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${userData.token}` }
    })

    if (!res.ok) {
      if (this.handleAuthError(res, e)) return
      await e.reply(`❌ 操作失败: ${res.data?.message || res.error}`)
      return
    }

    if (action === '更新开') {
      let msg = '✅ 闲时更新已开启！\n\n'
      msg += '🤖 Bot会在闲时自动为你更新成绩\n'
      if (res.data.message) msg += `📝 ${res.data.message}\n`
      msg += '\n💡 可搭配 #knd 自动导出水鱼开 实现全自动'
      await e.reply(msg)
    } else {
      await e.reply(`✅ 闲时更新已关闭。${res.data.message || ''}`)
    }
  }

  async autoExport(e) {
    const match = e.msg.match(/^#knd\s*自动导出(水鱼|落雪)(开|关)$/)
    if (!match) return

    const platform = match[1]
    const action = match[2]
    const userData = this.requireAuth(e)
    if (!userData) return

    const key = platform === '水鱼' ? 'autoExportDivingFish' : 'autoExportLxns'
    const value = action === '开'

    const res = await ApiClient.fetch(`${this.api}/users/profile`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${userData.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ [key]: value })
    })

    if (!res.ok) {
      if (this.handleAuthError(res, e)) return
      let tip = ''
      if (action === '开' && (res.data?.message?.includes('token') || res.data?.message?.includes('Token'))) {
        tip = `\n\n💡 请先绑定${platform}Token: #knd 绑定${platform} <Token>`
      }
      await e.reply(`❌ 设置失败: ${res.data?.message || res.error}${tip}`)
      return
    }

    const status = action === '开' ? '开启' : '关闭'
    let msg = `✅ ${platform}自动导出已${status}`
    if (action === '开') {
      msg += '\n\n📝 每次同步完成后将自动导出到' + platform
    }
    await e.reply(msg)
  }

  async setBackend(e) {
    const url = e.msg.replace(/^#knd\s*设置后端\s*/, '').trim()
    if (!url) {
      await e.reply('⚠️ 请输入后端地址\n\n例如: #knd 设置后端 http://127.0.0.1:9050/api')
      return
    }

    Config.setConfig('config', { backendUrl: url })
    await e.reply(`✅ 后端地址已设置为: ${url}`)
  }

  async help(e) {
    const msgs = [
      `基于好友vs的舞萌更新成绩插件使用帮助`,
      `━━ 📌 快速开始 ━━ 
发送导以开始引导绑定流程 绑定完成后后续只需要发送导即可自动开始上传数据`,
      `━━ 🔄 成绩同步 ━━ 
#knd sync 
  从官网同步最新成绩 
#knd 状态 
  查看当前同步任务进度 
💡 您随时可以发送 #knd 状态 查看同步进度
#knd 闲时更新开/关 
  开启/关闭自动更新 
#knd 闲时状态 
  查看闲时更新状态`,
      `━━ 🔗 导出平台 ━━ 
#knd 绑定水鱼 <Token> 
  设置水鱼查分器Token 
#knd 绑定水鱼账号 <用户名> <密码> 
  通过水鱼账号自动获取Token 
#knd 绑定落雪 <API Key> 
  设置落雪查分器Key 
#knd 更新水鱼 / #knd 更新落雪 
  导出成绩到对应平台 
#knd 更新全部 
  同时导出到水鱼和落雪`,
      `#knd 自动导出水鱼开/关 
  同步后自动导出到水鱼 
#knd 自动导出落雪开/关 
  同步后自动导出到落雪`,
      `━━ 📚 绑定教程 ━━ 
发送 水鱼帮助 获取水鱼查分器绑定教程
发送 落雪帮助 获取落雪查分器绑定教程`,
      `━━ ⚙️ 其他 ━━ 
#knd info    查看个人信息 
#knd 解绑    解除好友代码绑定 
#knd         查看快捷面板 

项目地址: https://github.com/knd-bot-dev-team/maimai-score-hub-plugin`
    ]

    const forwardMsg = []
    for (const msg of msgs) {
      forwardMsg.push({
        message: msg,
        nickname: Bot.nickname || 'Maimai Score Hub',
        user_id: Bot.uin
      })
    }

    await e.reply(await Bot.makeForwardMsg(forwardMsg))
  }

  async divingFishHelp(e) {
    const msgs = [
      `水鱼查分器绑定教程`,
      `请用手机的浏览器而非QQ打开 https://maimai.diving-fish.com/
点击登录并同步数据（如果没有账号请先注册一个）`,
      `登录后点击编辑个人资料
填入你的昵称（随意）绑定QQ号（填写你平常用的QQ号）
然后把非网页查询的成绩使用掩码取消勾选`,
      `然后看成绩导入token处 按照图片指示按1与2的按钮
提示已复制到剪切版时回到QQ`,
      `向群内或bot私聊发送#knd 绑定水鱼 加你刚刚复制的东西
就绑定好啦
此时发送导即可进行更新到水鱼的操作啦`
    ]

    const forwardMsg = []
    for (const msg of msgs) {
      forwardMsg.push({
        message: msg,
        nickname: Bot.nickname || 'Maimai Score Hub',
        user_id: Bot.uin
      })
    }

    const imgPath = path.join(PLUGIN_DIR, 'Screenshot_20260410_210132_Edge(1).jpg')
    
    if (fs.existsSync(imgPath)) {
      forwardMsg.push({
        message: segment.image(imgPath),
        nickname: Bot.nickname || 'Maimai Score Hub',
        user_id: Bot.uin
      })
    }

    await e.reply(await Bot.makeForwardMsg(forwardMsg))
  }

  async lxnsHelp(e) {
    const msgs = [
      `落雪查分器绑定教程`,
      `请用手机的浏览器而非QQ打开 https://maimai.lxns.net/
点击登录（如果没有账号请先注册一个）`,
      `登录后点击左上角三条杠
点击账号详细→舞萌dx→第三方应用`,
      `下滑点击个人api密钥的复制按钮
向群内或bot私聊发送#knd 绑定落雪 加你刚刚复制的东西`,
      `就绑定好啦
此时发送导即可进行更新到落雪的操作啦`
    ]

    const forwardMsg = []
    for (const msg of msgs) {
      forwardMsg.push({
        message: msg,
        nickname: Bot.nickname || 'Maimai Score Hub',
        user_id: Bot.uin
      })
    }

    await e.reply(await Bot.makeForwardMsg(forwardMsg))
  }
}
