/**
 * 串口镜像引擎集成冒烟(仅本机手动运行;依赖真实硬件/虚拟对,无则跳过):
 * - 物理口 COM72 @921600(真实 CP210x,ComClient 直开,tap 全真接线,不经 worker 跳)
 * - 虚拟对 COM33(外端,模拟"其他应用") <-> COM34(内端,镜像管理器打开)
 * - 验证:RX 白名单转发/丢弃、ownTx 黑名单转发、注入白名单判定、tap 开关联动、统计
 * - 注入方向仅记录不真发设备(避免向硬件灌测试字节);真实设备 RX 仅旁路观察
 */
import { describe, it, expect, vi } from 'vitest'
import { SerialPort } from 'serialport'
import ComClient from '@/main/protocol/ComClient'
import SerialMirrorManager from '@/main/mirror/SerialMirrorManager'
import type { MirrorConfig } from '@/main/mirror/rules'

const COM_PHYSICAL = 'COM72'
const BAUD = 921600
const COM_EXPOSED = 'COM33'
const COM_INTERNAL = 'COM34'
const SID = 'smoke-com72'

const waitFor = async (fn: () => boolean, timeoutMs = 3000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('waitFor timeout')
}

const config: MirrorConfig = {
  rx: { enabled: true, mode: 'whitelist', rules: [{ id: 'r1', target: 'hex', pattern: '^7E' }] },
  inject: { enabled: true, mode: 'whitelist', rules: [{ id: 'i1', target: 'bytes', pattern: String.raw`^\xAA` }] },
  ownTx: { enabled: true, mode: 'blacklist', rules: [] }
}

describe.skipIf(
  process.platform !== 'win32'
)('SerialMirror engine smoke (real COM72 + com0com pair)', () => {
  it('三个通道端到端', async () => {
    // 硬件探针:COM72 + 虚拟对缺任一即跳过(CI/其他机器)
    // mock 环境守卫:普通集成配置把 serialport 别名到 mock(其 list 返回 MOCK pnpId),
    // 本用例需要真实串口,须用 vitest.hardware.config.ts 运行
    const listed = await SerialPort.list()
    if (listed.some((x) => String((x as { pnpId?: string }).pnpId || '').startsWith('MOCK'))) {
      console.log('[smoke] mocked serialport env, skip (run with vitest.hardware.config.ts)')
      return
    }
    // serialport(SetupAPI)对部分虚拟口有枚举盲区,虚拟对以注册表 SERIALCOMM 为准
    const { execSync } = require('node:child_process')
    const regOut = (() => {
      try {
        return execSync('reg query HKLM\\HARDWARE\\DEVICEMAP\\SERIALCOMM', { encoding: 'utf8', timeout: 3000 })
      } catch {
        return ''
      }
    })()
    const regPorts = Array.from(String(regOut).matchAll(/COM\d+/g)).map((m) => m[0])
    const ports = [...(await SerialPort.list()).map((x) => x.path.toUpperCase()), ...regPorts]
    if (!ports.includes(COM_PHYSICAL) || !ports.includes(COM_EXPOSED) || !ports.includes(COM_INTERNAL)) {
      console.log('[smoke] hardware not present, skip:', ports.join(' '))
      return
    }
    const manager = SerialMirrorManager.getInstance()
    const injected: string[] = []
    const enableTap = vi.fn()
    manager.attachHooks({
      enableTap,
      sendToSession: async (_sid: string, command: string) => {
        injected.push(command)
      }
    })

    // 1. 物理会话:ComClient 直开真实端口
    const com = new ComClient()
    const deviceRx: string[] = []
    const startResult = await com.start(
      { comName: COM_PHYSICAL, baudRate: BAUD, sessionId: SID } as never,
      (d: { data: string }) => deviceRx.push(d.data),
      () => {},
      () => {}
    )
    expect((startResult as { success: boolean }).success).toBe(true)
    console.log('[step] com72 opened')

    // 2. 启动镜像:内端 COM34 由管理器打开
    const r = await manager.start({
      sessionId: SID,
      comName: COM_PHYSICAL,
      internalPort: COM_INTERNAL,
      exposedPort: COM_EXPOSED,
      config
    })
    console.log('[step] manager.start ->', JSON.stringify(r))
    expect(r.success).toBe(true)
    expect(enableTap).toHaveBeenCalledWith(SID, true)

    // 3. 真实接线 tap(worker 跳为纯传输,这里直连)
    com.setRawTap(SID, (chunk) => manager.onSessionRaw(SID, chunk))

    // 4. 外端模拟"其他应用"
    const otherChunks: Buffer[] = []
    const other = new SerialPort({ path: COM_EXPOSED, baudRate: 115200, autoOpen: true })
    other.on('data', (d: Buffer) => otherChunks.push(d))
    await new Promise<void>((resolve, reject) => { const t = setTimeout(() => reject(new Error('COM33 open timeout')), 3000); if (other.isOpen) { clearTimeout(t); resolve() } else { other.once('open', () => { clearTimeout(t); resolve() }); other.once('error', (e) => { clearTimeout(t); reject(e) }) } })
    console.log('[step] COM33 opened')
    const otherReceived = () => Buffer.concat(otherChunks)

    // --- RX 通道:白名单,7E 开头转发 ---
    manager.onSessionRaw(SID, Buffer.from([0x7e, 0x01, 0x55]))
    await waitFor(() => otherReceived().includes(Buffer.from([0x7e, 0x01, 0x55])))
    const lenAfterFwd = otherChunks.length
    // 非命中帧(AT...)不转发
    manager.onSessionRaw(SID, Buffer.from('AT+NOPE'))
    await new Promise((res) => setTimeout(res, 400))
    expect(otherReceived().includes(Buffer.from('AT+NOPE'))).toBe(false)
    expect(otherChunks.length).toBe(lenAfterFwd)

    // --- ownTx 通道:黑名单默认转发 ---
    manager.onSessionTx(SID, 'HELLO72')
    await waitFor(() => otherReceived().includes(Buffer.from('HELLO72')))

    // --- 注入通道:外端写入,白名单 ^\xAA 才进会话 ---
    other.write(Buffer.from([0xaa, 0x55, 0x01]))
    await waitFor(() => injected.length > 0)
    expect(injected[0]).toBe(Buffer.from([0xaa, 0x55, 0x01]).toString('latin1'))
    const injectedCount = injected.length
    other.write(Buffer.from([0x42, 0x42])) // 无 0xAA 前缀,丢弃
    await new Promise((res) => setTimeout(res, 400))
    expect(injected.length).toBe(injectedCount)

    // --- 统计 ---
    const status = manager.status() as Array<{ sessionId: string; stats: { rxFwd: number; ownTxFwd: number; injectFwd: number } }>
    const s = status.find((x) => x.sessionId === SID)!
    expect(s.stats.rxFwd).toBe(3)
    expect(s.stats.ownTxFwd).toBe('HELLO72'.length)
    expect(s.stats.injectFwd).toBe(3)

    // 旁路观察:测试窗口内真实设备若有数据,应同步出现在外端(非确定性,仅记录)
    await new Promise((res) => setTimeout(res, 1200))
    if (deviceRx.length > 0) console.log('[smoke] real device rx observed:', deviceRx.join('').slice(0, 80))

    // --- 清理 ---
    await manager.stop(SID)
    expect(enableTap).toHaveBeenCalledWith(SID, false)
    await com.disconnect(SID)
    await new Promise<void>((resolve) => other.close(() => resolve()))
  }, 30000)
})
