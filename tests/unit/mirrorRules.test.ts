/**
 * 串口镜像规则引擎单测
 */
import { describe, it, expect } from 'vitest'
import { decide, evaluateRules, matchTargets, type DirectionConfig, type MirrorRule } from '@/main/mirror/rules'

const rule = (id: string, target: 'bytes' | 'hex', pattern: string, flags?: string): MirrorRule =>
  ({ id, target, pattern, ...(flags ? { flags } : {}) })

const dir = (mode: 'whitelist' | 'blacklist', rules: MirrorRule[]): DirectionConfig =>
  ({ enabled: true, mode, rules })

// 一帧类 Modbus 数据: 7E 01 03 00 01 D3 7E;一段文本 "AT+VER\r\n"
const frame = Buffer.from([0x7e, 0x01, 0x03, 0x00, 0x01, 0xd3, 0x7e])
const text = Buffer.from('AT+VER\r\n', 'latin1')

describe('matchTargets', () => {
  it('bytes 为 latin1 一字节一字符,hex 为大写无分隔', () => {
    const t = matchTargets(frame)
    expect(t.hex).toBe('7E010300 01D37E'.replace(' ', ''))
    expect(t.bytes.charCodeAt(0)).toBe(0x7e)
    expect(t.bytes.length).toBe(7)
  })
})

describe('decide', () => {
  it('白名单:命中才转发,未命中丢弃', () => {
    const cfg = dir('whitelist', [rule('r1', 'hex', '^7E.*7E$')])
    expect(decide(cfg, frame)).toEqual({ forward: true, matchedRuleId: 'r1' })
    expect(decide(cfg, text).forward).toBe(false)
  })

  it('黑名单:命中丢弃,未命中转发', () => {
    const cfg = dir('blacklist', [rule('r1', 'bytes', '^AT')])
    expect(decide(cfg, text).forward).toBe(false)
    expect(decide(cfg, frame).forward).toBe(true)
  })

  it('字节目标用 \\xNN 表达二进制帧头帧尾', () => {
    // UI 输入框语义 = 原样字符串:String.raw 模拟用户直接输入 ^\x7e[\s\S]*\x7e$
    const cfg = dir('whitelist', [rule('r1', 'bytes', String.raw`^\x7e[\s\S]*\x7e$`)])
    expect(decide(cfg, frame).forward).toBe(true)
    expect(decide(cfg, text).forward).toBe(false)
  })

  it('按序求值首条命中生效', () => {
    const cfg = dir('blacklist', [rule('r1', 'bytes', '^AT'), rule('r2', 'bytes', 'VER')])
    // AT+VER 命中 r1 → 丢弃(不再看 r2)
    expect(decide(cfg, text)).toEqual({ forward: false, matchedRuleId: 'r1' })
  })

  it('enabled=false 一律不转发', () => {
    const cfg: DirectionConfig = { enabled: false, mode: 'blacklist', rules: [] }
    expect(decide(cfg, frame).forward).toBe(false)
  })

  it('无效正则跳过不中断', () => {
    const cfg = dir('whitelist', [rule('bad', 'hex', '('), rule('r2', 'hex', '^7E')])
    expect(decide(cfg, frame).forward).toBe(true)
  })

  it('二进制块经规则判定后字节不受损(转发路径用原始 Buffer)', () => {
    const t = matchTargets(Buffer.from([0xff, 0x80, 0x00]))
    expect(t.bytes.length).toBe(3)
    expect(Buffer.from(t.bytes, 'latin1').equals(Buffer.from([0xff, 0x80, 0x00]))).toBe(true)
  })
})

describe('evaluateRules (UI 预览)', () => {
  it('返回逐条 valid/matched', () => {
    const rows = evaluateRules([rule('bad', 'hex', '('), rule('ok', 'hex', '^7E')], frame)
    expect(rows[0]).toEqual({ id: 'bad', target: 'hex', valid: false, matched: false })
    expect(rows[1]).toEqual({ id: 'ok', target: 'hex', valid: true, matched: true })
  })
})
