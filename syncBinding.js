import fs from 'fs'
import path from 'path'

const PLUGIN_NAME = 'maimai-score-hub-plugin'
const TOKEN_FILE = path.join(process.cwd(), 'data', PLUGIN_NAME, 'tokens.json')

const MAIBOT_PLUGIN_NAME = 'maibot-plugin'

class SyncBinding {
  static getMaimaiScoreHubToken(userId) {
    try {
      if (!fs.existsSync(TOKEN_FILE)) return null
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'))
      return data[userId] || null
    } catch {
      return null
    }
  }

  static async syncToMaimaiScoreHub(userId, platform, token) {
    try {
      const hubToken = this.getMaimaiScoreHubToken(userId)
      if (!hubToken || !hubToken.token) {
        logger.info(`[同步绑定] 用户 ${userId} 未绑定 MaimaiScoreHub，跳过同步`)
        return { success: false, reason: 'not_bound' }
      }

      const configDir = path.join(process.cwd(), 'plugins', PLUGIN_NAME, 'config', 'config')
      const configFile = path.join(configDir, 'config.yaml')
      let backendUrl = 'https://api.maiscorehub.bakapiano.com/api'
      
      try {
        const YAML = (await import('yaml')).default
        if (fs.existsSync(configFile)) {
          const config = YAML.parse(fs.readFileSync(configFile, 'utf8'))
          backendUrl = config?.backendUrl || backendUrl
        }
      } catch {}

      const body = {}
      if (platform === 'fish') {
        body.divingFishImportToken = token
      } else if (platform === 'lxns') {
        body.lxnsImportToken = token
      }

      const response = await fetch(`${backendUrl}/users/profile`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${hubToken.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      })

      if (!response.ok) {
        const text = await response.text()
        let errMsg = text
        try {
          const json = JSON.parse(text)
          errMsg = json.message || text
        } catch {}
        logger.error(`[同步绑定] 同步到 MaimaiScoreHub 失败: ${errMsg}`)
        return { success: false, reason: errMsg }
      }

      logger.info(`[同步绑定] 已同步 ${platform} Token 到 MaimaiScoreHub: ${userId}`)
      return { success: true }
    } catch (err) {
      logger.error(`[同步绑定] 同步到 MaimaiScoreHub 异常:`, err)
      return { success: false, reason: err.message }
    }
  }

  static async syncToMaibot(userId, platform, token) {
    try {
      const dbPath = path.join(process.cwd(), 'plugins', MAIBOT_PLUGIN_NAME, 'model', 'db.js')
      const { MaibotDB } = await import(dbPath)
      
      const binding = await MaibotDB.getUserBinding(userId)
      if (!binding) {
        logger.info(`[同步绑定] 用户 ${userId} 未绑定 Maibot,跳过同步`)
        return { success: false, reason: 'not_bound' }
      }

      if (platform === 'fish') {
        binding.fishToken = token
      } else if (platform === 'lxns') {
        binding.lxnsCode = token
      }

      await MaibotDB.setUserBinding(userId, binding)
      logger.info(`[同步绑定] 已同步 ${platform} Token 到 Maibot: ${userId}`)
      return { success: true }
    } catch (err) {
      logger.error(`[同步绑定] 同步到 Maibot 异常:`, err)
      return { success: false, reason: err.message }
    }
  }

  static async syncBinding(userId, platform, token, source) {
    const results = {
      source,
      platform,
      maimaiScoreHub: null,
      maibot: null
    }

    if (source === 'maibot') {
      results.maimaiScoreHub = await this.syncToMaimaiScoreHub(userId, platform, token)
    } else if (source === 'maimaiScoreHub') {
      results.maibot = await this.syncToMaibot(userId, platform, token)
    }

    return results
  }
}

export default SyncBinding
