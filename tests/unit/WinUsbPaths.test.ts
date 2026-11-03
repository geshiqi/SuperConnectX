/**
 * WinUsbPaths 纯函数单测(跨平台,进 CI;FFI 直查部分在 integration 配置单独覆盖)
 */
import { describe, it, expect } from 'vitest'
import { trailingPort, parsePortHubLocation, parseNumericLocation } from '@/main/utils/WinUsbPaths'

describe('WinUsbPaths pure functions', () => {
  it('trailingPort 解析实例 ID 末段 &0&N', () => {
    expect(trailingPort('USB\\VID_05E3&PID_0610\\8&5AEB820&0&2')).toBe(2)
    expect(trailingPort('USB\\VID_10C4&PID_EA60\\48EE328AEE21F01182C814D936263638')).toBeNull()
    expect(trailingPort('USB\\ROOT_HUB30\\4&2FD48294&0&0')).toBe(0)
  })

  it('parsePortHubLocation 解析 Port_#N.Hub_#M 形式', () => {
    expect(parsePortHubLocation('Port_#0003.Hub_#0007')).toBe(3)
    expect(parsePortHubLocation('0000.0014.0000.008.003.003.003.000.000')).toBeNull()
    expect(parsePortHubLocation(null)).toBeNull()
  })

  it('parseNumericLocation 解析数值形式链(去 PCI 头 3 段与尾部 0)', () => {
    expect(parseNumericLocation('0000.0014.0000.008.003.003.003.000.000')).toBe('8.3.3.3')
    expect(parseNumericLocation('Port_#0003.Hub_#0007')).toBeNull()
    expect(parseNumericLocation('0000.0014')).toBeNull()
    expect(parseNumericLocation(null)).toBeNull()
  })
})
