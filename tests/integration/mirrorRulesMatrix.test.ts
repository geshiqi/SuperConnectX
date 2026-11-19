/**
 * 镜像规则矩阵 + 对内口占用行为(vitest.hardware 配置,真实 com0com 对,无需物理设备)
 */
import { describe, it, expect, vi } from 'vitest'
import { SerialPort } from 'serialport'
import SerialMirrorManager, { defaultMirrorConfig } from '@/main/mirror/SerialMirrorManager'
import type { MirrorConfig } from '@/main/mirror/rules'

const SID = 'matrix'
const EXPOSED = 'COM33'
const INTERNAL = 'COM34'
const waitFor = async (fn: () => boolean, ms = 3000) => {
  const dl = Date.now() + ms
  while (Date.now() < dl) { if (fn()) return; await new Promise(r => setTimeout(r, 20)) }
  throw new Error('waitFor timeout')
}

let ports = (await SerialPort.list()).map(x => x.path)
try { // com0com 口对 SetupAPI 枚举有盲区,注册表兜底
  const reg = require('node:child_process').execSync('reg query HKLM\\HARDWARE\\DEVICEMAP\\SERIALCOMM', { encoding: 'utf8', timeout: 3000 })
  ports = [...ports, ...Array.from(String(reg).matchAll(/COM\d+/g)).map(m => m[0])]
} catch { /* ignore */ }
const pairOk = ports.includes(EXPOSED) && ports.includes(INTERNAL)

describe.skipIf(!pairOk)('mirror rules matrix (real pair)', () => {
  it('规则矩阵:双目标/黑白名单/无效正则/热更新/占用防护', async () => {
    const injected: string[] = []
    const mgr = SerialMirrorManager.getInstance()
    mgr.attachHooks({ enableTap: vi.fn(), sendToSession: async (_s, c) => { injected.push(c) } })
    // 外部读端
    const rx: Buffer[] = []
    const other = new SerialPort({ path: EXPOSED, baudRate: 115200 })
    other.on('data', d => rx.push(d))
    await new Promise<void>(r => (other.isOpen ? r() : other.once('open', () => r())))
    const seen = () => rx.map(c => c.toString('hex').toUpperCase())

    const cfg: MirrorConfig = {
      rx: { enabled: true, mode: 'whitelist', rules: [
        { id: 'h7e', target: 'hex', pattern: '^7E' },
        { id: 'bat', target: 'bytes', pattern: String.raw`^\xAA` }
      ] },
      inject: { enabled: true, mode: 'blacklist', rules: [{ id: 'noat', target: 'bytes', pattern: '^AT' }] },
      ownTx: { enabled: true, mode: 'whitelist', rules: [{ id: 'bad', target: 'hex', pattern: '(' }, { id: 'ok', target: 'bytes', pattern: '^KEEP' }] }
    }
    expect((await mgr.start({ sessionId: SID, comName: 'TEST', internalPort: INTERNAL, exposedPort: EXPOSED, config: cfg })).success).toBe(true)

    // --- RX:白名单 hex ^7E / bytes ^\xAA 各转发,其他丢弃 ---
    mgr.onSessionRaw(SID, Buffer.from([0x7e, 0x01]))
    mgr.onSessionRaw(SID, Buffer.from([0xaa, 0x02]))
    mgr.onSessionRaw(SID, Buffer.from('JUNK99'))
    await waitFor(() => seen().length >= 2)
    expect(seen()).toContain('7E01'); expect(seen()).toContain('AA02')
    expect(seen().some(x => x.includes('4A554E4B'))).toBe(false) // JUNK 丢弃

    // --- ownTx:白名单 ^KEEP 转发;无效正则 ( 被跳过不炸 ---
    mgr.onSessionTx(SID, 'KEEPYES'); mgr.onSessionTx(SID, 'DROPNO')
    await waitFor(() => seen().includes(Buffer.from('KEEPYES').toString('hex').toUpperCase()))
    expect(seen().some(x => x.includes('44524F504E4F'))).toBe(false)

    // --- inject:黑名单 ^AT 丢弃,其他注入 ---
    other.write(Buffer.from('AT+X')); other.write(Buffer.from([0x31]))
    await waitFor(() => injected.length >= 1)
    expect(injected[0]).toBe('1'); expect(injected.some(x => x.startsWith('AT'))).toBe(false)

    // --- 热更新:rx 切黑名单后 JUNK 也转发 ---
    await mgr.updateConfig(SID, { ...cfg, rx: { enabled: true, mode: 'blacklist', rules: [] } })
    const n = seen().length
    mgr.onSessionRaw(SID, Buffer.from('JUNK2'))
    await waitFor(() => seen().length > n)

    await mgr.stop(SID); await new Promise<void>(r => other.close(() => r()))
  }, 20000)

  it('对内口被占用:start 必须明确失败且不留幽灵会话', async () => {
    const hold = new SerialPort({ path: INTERNAL, baudRate: 115200, autoOpen: false })
    await new Promise<void>(r => hold.open(() => r()))
    const mgr = SerialMirrorManager.getInstance()
    const r = await mgr.start({ sessionId: 'occ', comName: 'T', internalPort: INTERNAL, exposedPort: EXPOSED, config: defaultMirrorConfig() })
    // 断言修复后的契约:占用时 success=false 且 status 无该会话
    expect(r.success).toBe(false)
    expect((mgr.status() as object[]).some(s => (s as { sessionId: string }).sessionId === 'occ')).toBe(false)
    await new Promise<void>(res => hold.close(() => res()))
  }, 15000)
})
