import plugin from '../../lib/plugins/plugin.js'
import fs from 'fs'
import path from 'path'

// 配置项
const BACKEND_URL = 'https://api.maiscorehub.bakapiano.com/api'
const TOKEN_FILE = './data/maimai-score-hub/tokens.json'

// 确保数据目录存在
if (!fs.existsSync(path.dirname(TOKEN_FILE))) {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true })
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
          reg: '^#knd\\s*bind\\s*(.+)$',
          fnc: 'bind'
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
          reg: '^#knd\\s*更新(水鱼|落雪)$',
          fnc: 'exportData'
        },
        {
          reg: '^#knd\\s*绑定(水鱼|落雪)\\s*(.+)$',
          fnc: 'setToken'
        },
        {
          reg: '^#knd\\s*更新全部$',
          fnc: 'exportAll'
        },
        {
          reg: '^#knd\\s*sync\\s*help$',
          fnc: 'help'
        }
      ]
    })
  }

  // 获取保存的 Token
  getToken(userId) {
    if (!fs.existsSync(TOKEN_FILE)) return null
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'))
    return data[userId] || null
  }

  // 保存 Token
  saveToken(userId, token, friendCode) {
    let data = {}
    if (fs.existsSync(TOKEN_FILE)) {
      data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'))
    }
    data[userId] = { token, friendCode }
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2))
  }

  // 通用 Fetch 请求
  async fetchApi(url, options = {}) {
    try {
      const response = await fetch(url, options)
      const contentType = response.headers.get('content-type')
      if (contentType && contentType.includes('application/json')) {
        return { ok: response.ok, status: response.status, data: await response.json() }
      }
      return { ok: response.ok, status: response.status, text: await response.text() }
    } catch (error) {
      console.error('[MaimaiScoreHub] Fetch Error:', error)
      return { ok: false, error: error.message }
    }
  }

  // 尝试撤回消息
  async safeRecall(e, messageId) {
    try {
      if (e.group && e.group.recallMsg && messageId) {
        await e.group.recallMsg(messageId)
      } else if (e.recall && !messageId) {
        // 如果没有 messageId，e.recall() 通常撤回的是用户触发指令的消息
        // 这里主要用于撤回 bot 发送的消息，所以需要 messageId
      }
    } catch (err) {
      console.error('[MaimaiScoreHub] Recall Error:', err)
    }
  }

  // 绑定用户 (登录)
  async bind(e) {
    const friendCode = e.msg.replace(/^#knd\s*bind\s*/, '').trim()
    if (!friendCode) {
      await e.reply('请输入好友代码，好友代码可以在舞萌dx公众号→好友→你的好友号码中找到')
      return
    }

    const msg1 = await e.reply(`正在请求绑定好友代码: ${friendCode}...`)

    // 1. 请求登录
    const reqRes = await this.fetchApi(`${BACKEND_URL}/auth/login-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ friendCode })
    })

    if (!reqRes.ok) {
      if (msg1 && msg1.message_id) await this.safeRecall(e, msg1.message_id)
      await e.reply(`请求失败: ${reqRes.data?.message || reqRes.error || '未知错误'}`)
      return
    }

    const { jobId, skipAuth, token, user } = reqRes.data

    // 如果 skipAuth 为 true，直接绑定成功
    if (skipAuth) {
      if (msg1 && msg1.message_id) await this.safeRecall(e, msg1.message_id)
      this.saveToken(e.user_id, token, user.friendCode)
      await e.reply(`绑定成功！(Skip Auth)\n用户ID: ${user._id}\n请绑定水鱼token或落雪api key进行游戏成绩同步操作`)
      return
    }

    const msg2 = await e.reply(`请求已提交 (Job ID: ${jobId})，正在等待 Worker 处理...请稍候...`)

    // 2. 轮询状态
    const startTime = Date.now()
    const timeout = 120 * 1000 // 2分钟超时
    const interval = 3000 // 3秒轮询

    const checkLoop = setInterval(async () => {
      if (Date.now() - startTime > timeout) {
        clearInterval(checkLoop)
        await e.reply('绑定超时，请稍后重试。可能 Worker 未启动或处理缓慢。')
        return
      }

      const statusRes = await this.fetchApi(`${BACKEND_URL}/auth/login-status?jobId=${jobId}`)
      
      if (!statusRes.ok) {
        // 忽略临时错误
        return
      }

      const { status, token, user } = statusRes.data

      if (token) {
        clearInterval(checkLoop)
        if (msg1 && msg1.message_id) await this.safeRecall(e, msg1.message_id)
        if (msg2 && msg2.message_id) await this.safeRecall(e, msg2.message_id)
        this.saveToken(e.user_id, token, user.friendCode)
        await e.reply(`绑定成功！\n好友代码: ${user.friendCode}\n用户ID: ${user._id}\n请绑定水鱼token或落雪api key进行游戏成绩同步操作`)
      } else if (status === 'failed') {
        clearInterval(checkLoop)
        await e.reply('绑定失败，Worker 处理出错。')
      }
      // 其他状态 (pending, processing) 继续等待
    }, interval)
  }

  // 触发同步 (创建 Job)
  async sync(e) {
    const userData = this.getToken(e.user_id)
    if (!userData) {
      await e.reply('请先绑定好友代码: #knd bind <code')
      return
    }

    const msg1 = await e.reply('正在创建同步任务...')
    
    // 使用 friendCode 创建任务，不需要 Token (根据 JobController 定义)
    const res = await this.fetchApi(`${BACKEND_URL}/job/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ friendCode: userData.friendCode })
    })

    if (!res.ok) {
      if (msg1 && msg1.message_id) await this.safeRecall(e, msg1.message_id)
      await e.reply(`同步请求失败: ${res.data?.message || res.error}`)
      return
    }

    // 任务创建成功，撤回"正在创建"消息
    if (msg1 && msg1.message_id) await this.safeRecall(e, msg1.message_id)

    const { jobId } = res.data
    const msg2 = await e.reply('请您到舞萌dx公众号同意最近一次的好友申请以进行同步操作')
    const msg3 = await e.reply('您可以到 https://maimai.bakapiano.com/app/sync 填写同一个好友代码以查看同步状态')

    // 轮询 Job 状态
    const startTime = Date.now()
    const timeout = 300 * 1000 // 5分钟超时
    const interval = 3000 // 3秒轮询

    const checkLoop = setInterval(async () => {
      if (Date.now() - startTime > timeout) {
        clearInterval(checkLoop)
        await e.reply('同步超时，请稍后重试。')
        return
      }

      const jobRes = await this.fetchApi(`${BACKEND_URL}/job/${jobId}`)
      
      if (!jobRes.ok) {
        // 忽略临时错误
        return
      }

      const { status, error } = jobRes.data

      if (status === 'completed') {
        clearInterval(checkLoop)
        // 成功完成操作，撤回提示消息
        if (msg2 && msg2.message_id) await this.safeRecall(e, msg2.message_id)
        if (msg3 && msg3.message_id) await this.safeRecall(e, msg3.message_id)
        
        await e.reply('sync成功！查分器同步还未完成。请执行#knd 更新水鱼/#knd 更新落雪或#knd 更新全部以同步到查分器平台', true)
      } else if (status === 'failed' || status === 'canceled') {
        clearInterval(checkLoop)
        await e.reply(`同步失败: ${error || '未知错误'}`)
      }
      // 其他状态 (pending, processing) 继续等待
    }, interval)
  }

  // 查看信息
  async info(e) {
    const userData = this.getToken(e.user_id)
    if (!userData) {
      await e.reply('请先绑定好友代码: #knd bind <code')
      return
    }

    const res = await this.fetchApi(`${BACKEND_URL}/users/profile`, {
      headers: { 'Authorization': `Bearer ${userData.token}` }
    })

    if (!res.ok) {
      if (res.status === 401) {
        await e.reply('授权已过期，请重新绑定。')
      } else {
        await e.reply(`获取信息失败: ${res.data?.message || res.error}`)
      }
      return
    }

    const profile = res.data
    // 调试日志
    console.log('[MaimaiScoreHub] Profile:', JSON.stringify(profile))
    
    let msg = `knd查到了你的信息!\n`
    msg += `Friend Code: ${profile.friendCode}\n`
    msg += `ID: ${profile._id}\n`
    msg += `Diving Fish Token: ${profile.divingFishImportToken ? '已设置' : '未设置'}\n`
    msg += `LXNS Token: ${profile.lxnsImportToken ? '已设置' : '未设置'}`
    
    await e.reply(msg)
  }

  // 导出数据
  async exportData(e) {
    const match = e.msg.match(/^#knd\s*更新(水鱼|落雪)$/)
    if (!match) return
    const platform = match[1] === '水鱼' ? 'df' : 'lxns'

    const userData = this.getToken(e.user_id)
    if (!userData) {
      await e.reply('请先绑定好友代码: #knd bind <code')
      return
    }

    const endpoint = platform === 'df' ? 'diving-fish' : 'lxns'
    const platformName = platform === 'df' ? '水鱼 (Diving Fish)' : '落雪 (LXNS)'

    const processingMsg = await e.reply(`正在导出数据到 ${platformName}...`)

    const res = await this.fetchApi(`${BACKEND_URL}/sync/latest/${endpoint}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${userData.token}` }
    })

    if (processingMsg && processingMsg.message_id) {
      await this.safeRecall(e, processingMsg.message_id)
    }

    if (!res.ok) {
      await e.reply(`导出失败: ${res.data?.message || res.error}`, true)
      return
    }

    // 美化输出
    const data = res.data
    let msg = `更新${match[1]}成功！\n`
    if (data.response && data.response.message) {
      // 移除可能重复的 "更新成功" 字样，如果后端返回了
      const backendMsg = data.response.message.replace('更新成功', '').trim()
      if (backendMsg) msg += `${backendMsg}\n`
    }
    
    if (data.exported !== undefined) {
      msg += `共导出: ${data.exported} 首\n`
    }
    
    if (data.response) {
      const parts = []
      if (data.response.creates !== undefined) parts.push(`新增: ${data.response.creates}`)
      if (data.response.updates !== undefined) parts.push(`更新: ${data.response.updates}`)
      if (parts.length > 0) msg += parts.join(', ')
    }

    await e.reply(msg.trim(), true)
  }

  // 导出全部
  async exportAll(e) {
    const userData = this.getToken(e.user_id)
    if (!userData) {
      await e.reply('请先绑定好友代码: #knd bind <code')
      return
    }

    const processingMsg = await e.reply('正在导出数据到 水鱼 和 落雪...')
    
    // 并行请求
    const [dfRes, lxnsRes] = await Promise.all([
      this.fetchApi(`${BACKEND_URL}/sync/latest/diving-fish`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${userData.token}` }
      }),
      this.fetchApi(`${BACKEND_URL}/sync/latest/lxns`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${userData.token}` }
      })
    ])

    if (processingMsg && processingMsg.message_id) {
      await this.safeRecall(e, processingMsg.message_id)
    }

    let msg = ''
    
    // 处理水鱼结果
    if (dfRes.ok) {
      const d = dfRes.data
      msg += `[水鱼] 更新成功\n`
      if (d.exported !== undefined) msg += `   导出: ${d.exported} (新增: ${d.response?.creates ?? 0}, 更新: ${d.response?.updates ?? 0})\n`
    } else {
      msg += `[水鱼] 失败: ${dfRes.data?.message || dfRes.error}\n`
    }

    // 处理落雪结果
    if (lxnsRes.ok) {
      const d = lxnsRes.data
      msg += `[落雪] 更新成功\n`
      if (d.exported !== undefined) msg += `   导出: ${d.exported} (新增: ${d.response?.creates ?? 0}, 更新: ${d.response?.updates ?? 0})`
    } else {
      msg += `[落雪] 失败: ${lxnsRes.data?.message || lxnsRes.error}`
    }

    await e.reply(msg.trim(), true)
  }

  // 设置 Token
  async setToken(e) {
    const match = e.msg.match(/^#knd\s*绑定(水鱼|落雪)\s*(.+)$/)
    if (!match) return

    const platform = match[1] === '水鱼' ? 'df' : 'lxns'
    const tokenInput = match[2].trim()
    const userData = this.getToken(e.user_id)
    
    if (!userData) {
      await e.reply('请先绑定好友代码: #knd bind <code')
      return
    }

    const platformName = platform === 'df' ? '水鱼 (Diving Fish)' : '落雪 (LXNS)'
    
    const processingMsg = await e.reply(`正在绑定 ${platformName} Token...`)

    // Workaround: 先获取现有 Profile，防止覆盖
    let existingProfile = {}
    try {
      const profileRes = await this.fetchApi(`${BACKEND_URL}/users/profile`, {
        headers: { 'Authorization': `Bearer ${userData.token}` }
      })
      if (profileRes.ok && profileRes.data) {
        existingProfile = profileRes.data
      }
    } catch (err) {
      console.warn('Failed to fetch existing profile for merge:', err)
    }

    const body = {}
    // 填充现有值
    if (existingProfile.divingFishImportToken !== undefined && existingProfile.divingFishImportToken !== null) {
      body.divingFishImportToken = existingProfile.divingFishImportToken
    }
    if (existingProfile.lxnsImportToken !== undefined && existingProfile.lxnsImportToken !== null) {
      body.lxnsImportToken = existingProfile.lxnsImportToken
    }

    // 覆盖新值
    if (platform === 'df') {
      body.divingFishImportToken = tokenInput
    } else {
      body.lxnsImportToken = tokenInput
    }

    const res = await this.fetchApi(`${BACKEND_URL}/users/profile`, {
      method: 'PATCH',
      headers: { 
        'Authorization': `Bearer ${userData.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })

    if (processingMsg && processingMsg.message_id) {
      await this.safeRecall(e, processingMsg.message_id)
    }

    if (!res.ok) {
      await e.reply(`绑定失败: ${res.data?.message || res.error}`, true)
      return
    }

    await e.reply(`绑定${match[1]}成功！现在可以使用 #knd 更新${match[1]} 导出成绩了。`, true)

    // 尝试撤回用户消息 (Token)
    try {
      if (e.recall) {
        await e.recall()
      } else if (e.group && e.group.recallMsg) {
        await e.group.recallMsg(e.message_id)
      }
      await e.reply(`正在尝试撤回您的token，如果失败请手动撤回`, true)
    } catch (err) {
      console.error('[MaimaiScoreHub] Recall Error:', err)
      await e.reply(`正在尝试撤回您的token，如果失败请手动撤回`, true)
    }
  }

  // 帮助指令
  async help(e) {
    const msg = `【knd sync帮助】
1. 绑定/登录:
   #knd bind <好友代码>
   (例如: #knd bind 1234567890123)

2. 同步成绩:
   #knd sync
   (从游戏官网拉取最新成绩)

3. 绑定导出平台:
   #knd 绑定水鱼 <Token>
   #knd 绑定落雪 <API Key>

4. 导出成绩:
   #knd 更新水鱼
   #knd 更新落雪
   #knd 更新全部 (同时导出到双平台)

5. 查看信息:
   #knd info

本功能仅处于内测阶段，后续有要求或使用人数增加将会取消每次都需要同意好友请求的操作`
    await e.reply(msg)
  }
}
