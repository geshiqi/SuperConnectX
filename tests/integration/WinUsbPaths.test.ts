/**
 * WinUsbPaths FFI 集成测试:仅 win32 执行(skipIf,CI 的 Linux/macOS 任务自动跳过),
 * 含 500 次压测验证无原生崩溃。纯函数单测在 tests/unit/WinUsbPaths.test.ts
 */
import { describe, it, expect } from 'vitest'
import { getWindowsUsbPaths } from '@/main/utils/WinUsbPaths'

describe.skipIf(process.platform !== 'win32')('WinUsbPaths FFI (win32 only)', () => {
  it('直查返回 USB 设备拓扑路径,值形如 8.3.3.2.3', () => {
    const map = getWindowsUsbPaths()
    // 本机对照 finduart 的已知值(输出供人工核对)
    console.log('[WinUsbPaths] query result:', JSON.stringify([...map.entries()]))
    expect(map.size).toBeGreaterThan(0)
    for (const path of map.values()) {
      expect(path).toMatch(/^\d+(\.\d+)+$/)
    }
  })

  it('压测 500 次无崩溃且结果稳定', () => {
    const first = getWindowsUsbPaths()
    expect(first.size).toBeGreaterThan(0)
    for (let i = 0; i < 500; i++) {
      const next = getWindowsUsbPaths()
      if (next.size !== first.size) throw new Error(`unstable at iteration ${i}`)
    }
  })
})
