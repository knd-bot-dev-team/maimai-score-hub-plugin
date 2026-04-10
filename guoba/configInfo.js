import fs from 'fs'
import path from 'path'
import YAML from 'yaml'

const PLUGIN_DIR = path.join(process.cwd(), 'plugins', 'maimai-score-hub-plugin')
const CONFIG_DIR = path.join(PLUGIN_DIR, 'config', 'config')
const DEFAULT_CONFIG_DIR = path.join(PLUGIN_DIR, 'config', 'default_config')

function getConfig() {
  const configFile = path.join(CONFIG_DIR, 'config.yaml')
  if (!fs.existsSync(configFile)) {
    const defaultFile = path.join(DEFAULT_CONFIG_DIR, 'config.yaml')
    if (fs.existsSync(defaultFile)) {
      return YAML.parse(fs.readFileSync(defaultFile, 'utf8')) || {}
    }
    return {}
  }
  try {
    return YAML.parse(fs.readFileSync(configFile, 'utf8')) || {}
  } catch {
    return {}
  }
}

function setConfig(data) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(path.join(CONFIG_DIR, 'config.yaml'), YAML.stringify(data))
}

export const schemas = [
  {
    field: 'backendUrl',
    label: '后端 API 地址',
    component: 'Input',
    required: true,
    defaultValue: 'https://api.maiscorehub.bakapiano.com/api',
    placeholder: 'https://api.maiscorehub.bakapiano.com/api'
  }
]

export function getConfigData() {
  return getConfig()
}

export function setConfigData(data, { Result }) {
  setConfig(data)
  return Result.ok({}, '保存成功')
}
