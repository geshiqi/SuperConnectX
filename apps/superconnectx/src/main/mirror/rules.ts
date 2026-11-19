/**
 * 串口镜像规则引擎(纯函数)。
 *
 * 镜像数据流三个方向各自持有一组规则:按序求值,首条命中生效;均未命中走模式默认动作
 * (白名单=默认丢弃,黑名单=默认转发)。每条规则自选匹配目标:
 * - bytes:原始字节按 latin1 一字节一字符,正则用 \xNN 表达字节值(二进制协议帧头帧尾)
 * - hex:  块转 HEX 大写文本后匹配(如 ^7E.*D3,贴合盯 HEX 看的习惯)
 * 无效正则跳过该条(不中断其余规则)。
 */

export type MirrorTarget = 'bytes' | 'hex'
export type MirrorMode = 'whitelist' | 'blacklist'

export interface MirrorRule {
  id: string
  target: MirrorTarget
  pattern: string
  flags?: string
}

export interface DirectionConfig {
  enabled: boolean
  mode: MirrorMode
  rules: MirrorRule[]
}

export interface MirrorConfig {
  /** 设备收到的数据 → 是否转发到镜像口 */
  rx: DirectionConfig
  /** 镜像口对端发来的数据 → 是否注入发往设备 */
  inject: DirectionConfig
  /** 自己终端发送的数据 → 是否同步转发到镜像口 */
  ownTx: DirectionConfig
}

export interface RuleDecision {
  forward: boolean
  matchedRuleId?: string
}

const regexCache = new Map<string, RegExp | null>()

function compile(rule: MirrorRule): RegExp | null {
  const key = `${rule.target}:${rule.pattern}:${rule.flags ?? ''}`
  if (regexCache.has(key)) return regexCache.get(key) ?? null
  let re: RegExp | null = null
  try {
    re = new RegExp(rule.pattern, rule.flags ?? '')
  } catch {
    re = null
  }
  regexCache.set(key, re)
  return re
}

/** 块的两个匹配目标文本(bytes=latin1 一字节一字符;hex=大写无分隔) */
export function matchTargets(chunk: Buffer): { bytes: string; hex: string } {
  return { bytes: chunk.toString('latin1'), hex: chunk.toString('hex').toUpperCase() }
}

/** 对一个数据块按方向配置求值。enabled=false 一律不转发 */
export function decide(config: DirectionConfig, chunk: Buffer): RuleDecision {
  if (!config.enabled) return { forward: false }
  const targets = matchTargets(chunk)
  for (const rule of config.rules) {
    const re = compile(rule)
    if (!re) continue
    const text = rule.target === 'hex' ? targets.hex : targets.bytes
    if (re.test(text)) {
      return { forward: config.mode === 'whitelist', matchedRuleId: rule.id }
    }
  }
  return { forward: config.mode === 'blacklist' }
}

/** UI 预览用:返回逐条规则的命中详情(首命中即决策) */
export function evaluateRules(
  rules: MirrorRule[],
  chunk: Buffer
): Array<{ id: string; target: MirrorTarget; valid: boolean; matched: boolean }> {
  const targets = matchTargets(chunk)
  return rules.map((rule) => {
    const re = compile(rule)
    const valid = re !== null
    const matched = valid ? re!.test(rule.target === 'hex' ? targets.hex : targets.bytes) : false
    return { id: rule.id, target: rule.target, valid, matched }
  })
}
