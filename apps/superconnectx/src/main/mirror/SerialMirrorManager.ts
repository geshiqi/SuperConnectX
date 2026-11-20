/**
 * SerialMirrorManager - 串口镜像/分流(模式 A:挂载在终端会话上)。
 *
 * 架构:物理口由终端会话独占(worker 内 ComClient);镜像功能在主进程打开 com0com
 * 虚拟对的"内端"(如 COM31),对外暴露"外端"(如 COM30)给其他应用:
 *   设备 RX --(会话原始字节 tap,worker 经 mirror-raw 上报)--> 规则 --> 写内端 --> 外端
 *   外端数据 --(内端 data)--> 规则 --> 会话发送路径注入设备
 *   自己 TX --(send-data 拦截)--> 规则 --> 写内端
 * 会话原始字节 tap 与注入发送器由 IpcConnector 注入(attachHooks),避免循环依赖。
 */
import { ipcMain } from 'electron'
import { SerialPort } from 'serialport'
import logger from '../ipc/IpcAppLogger'
import { decide, type MirrorConfig } from './rules'

export interface MirrorStartPayload {
  sessionId: string
  comName: string
  /** 镜像打开的内端(com0com 对的一端,如 COM31) */
  internalPort: string
  /** 对外暴露给其他应用的一端(如 COM30,仅展示用) */
  exposedPort: string
  config: MirrorConfig
}

interface MirrorStats {
  rxFwd: number
  rxDrop: number
  injectFwd: number
  injectDrop: number
  ownTxFwd: number
}

interface MirrorSession {
  payload: MirrorStartPayload
  port: SerialPort
  stats: MirrorStats
}

/** 由 IpcConnector 注入的会话钩子 */
export interface MirrorHooks {
  /** 开关物理会话的原始字节上报(worker 内 ComClient tap) */
  enableTap: (sessionId: string, enabled: boolean) => void
  /** 把数据经会话发送路径注入设备(命令为 latin1 二进制串,复用二进制安全发送链) */
  sendToSession: (sessionId: string, command: string) => Promise<unknown> | unknown
}

interface WindowsRef {
  mainWindow?: { webContents?: { send: (channel: string, ...args: unknown[]) => void }; isDestroyed?: () => boolean } | null
}

export function defaultMirrorConfig(): MirrorConfig {
  const emptyDir = { enabled: false, mode: 'whitelist' as const, rules: [] }
  return {
    rx: { ...emptyDir, enabled: true, mode: 'blacklist' as const },
    inject: { ...emptyDir },
    ownTx: { ...emptyDir }
  }
}

export default class SerialMirrorManager {
  private static sInstance: SerialMirrorManager
  private readonly sessions = new Map<string, MirrorSession>()
  private hooks: MirrorHooks | null = null
  private windows: WindowsRef | null = null

  static getInstance(): SerialMirrorManager {
    if (SerialMirrorManager.sInstance == null) {
      SerialMirrorManager.sInstance = new SerialMirrorManager()
    }
    return SerialMirrorManager.sInstance
  }

  init(windows: WindowsRef): void {
    this.windows = windows
    ipcMain.handle('mirror:start', (_e, payload: MirrorStartPayload) => this.start(payload))
    ipcMain.handle('mirror:stop', (_e, sessionId: string) => this.stop(sessionId))
    ipcMain.handle('mirror:status', () => this.status())
    // 免提权列举 com0com 口:注册表 SERIALCOMM 中设备名含 com0com(setupc list 需 UAC,不适合弹窗内调用)
    ipcMain.handle('mirror:list-com0com-ports', () => {
      try {
        const out = require('node:child_process').execSync('reg query HKLM\\HARDWARE\\DEVICEMAP\\SERIALCOMM', { encoding: 'utf8', timeout: 3000 })
        const ports: string[] = []
        for (const line of out.split(/\r?\n/)) {
          const mch = line.match(/com0com\S*\s+REG_SZ\s+(COM\d+)/i)
          if (mch) ports.push(mch[1])
        }
        return ports.sort((a, b) => parseInt(a.slice(3)) - parseInt(b.slice(3)))
      } catch {
        return []
      }
    })
    ipcMain.handle('mirror:update-config', (_e, sessionId: string, config: MirrorConfig) =>
      this.updateConfig(sessionId, config)
    )
    logger.info('init SerialMirrorManager done')
  }

  attachHooks(hooks: MirrorHooks): void {
    this.hooks = hooks
  }

  private emitEvent(kind: string, sessionId: string, message?: string): void {
    const win = this.windows?.mainWindow
    if (win && !win.isDestroyed?.()) {
      win.webContents?.send('mirror:event', { kind, sessionId, message })
    }
  }

  async start(payload: MirrorStartPayload): Promise<{ success: boolean; message?: string }> {
    if (!payload?.sessionId || !payload?.internalPort) {
      return { success: false, message: 'missing sessionId/internalPort' }
    }
    if (this.sessions.has(payload.sessionId)) await this.stop(payload.sessionId)
    // com0com 无波特率仿真,波特率参数不影响;115200 占位
    // 显式 open 并 await:autoOpen:true 的打开失败只走 error 事件不抛异常,
    // 曾致内口被占用时 start 假报成功(幽灵会话,后续写入全部静默失败)
    const port = new SerialPort({ path: payload.internalPort, baudRate: 115200, autoOpen: false })
    const openError = await new Promise<Error | null>((resolve) => {
      port.open((err) => resolve(err ?? null))
      port.once('error', (err: Error) => resolve(err))
    })
    if (openError || !port.isOpen) {
      try { port.close() } catch { /* ignore */ }
      const message = `内口 ${payload.internalPort} 打开失败: ${openError?.message ?? 'unknown'}(可能被终端标签页或其他应用占用)`
      logger.error(`[mirror] start failed: ${message}`)
      this.emitEvent('error', payload.sessionId, message)
      return { success: false, message }
    }
    try {
      const session: MirrorSession = { payload, port, stats: { rxFwd: 0, rxDrop: 0, injectFwd: 0, injectDrop: 0, ownTxFwd: 0 } }
      port.on('data', (buf: Buffer) => this.onPairData(payload.sessionId, buf))
      port.on('close', () => {
        // 内端被关/出错:清理并通知(外端应用关闭串口通常不触发,com0com 对常驻)
        if (this.sessions.get(payload.sessionId)?.port === port) {
          this.sessions.delete(payload.sessionId)
          try { this.hooks?.enableTap(payload.sessionId, false) } catch { /* 断开竞态时 worker 可能已终止 */ }
          this.emitEvent('stopped', payload.sessionId, 'pair port closed')
        }
      })
      port.on('error', (err: Error) => {
        logger.error(`[mirror] pair port error: ${err.message}`)
      })
      this.sessions.set(payload.sessionId, session)
      try { this.hooks?.enableTap(payload.sessionId, true) } catch { /* 断开竞态时 worker 可能已终止 */ }
      logger.info(`[mirror] started: ${payload.comName} -> ${payload.exposedPort} (internal ${payload.internalPort})`)
      this.emitEvent('started', payload.sessionId)
      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error(`[mirror] start failed: ${message}`)
      return { success: false, message }
    }
  }

  async stop(sessionId: string): Promise<{ success: boolean }> {
    const session = this.sessions.get(sessionId)
    try { this.hooks?.enableTap(sessionId, false) } catch { /* 断开竞态时 worker 可能已终止 */ }
    if (!session) return { success: true }
    this.sessions.delete(sessionId)
    try {
      session.port.close()
    } catch {
      /* ignore */
    }
    logger.info(`[mirror] stopped: ${sessionId}`)
    this.emitEvent('stopped', sessionId)
    return { success: true }
  }

  /** 会话收到的原始字节(worker tap 上报):规则判定后转发到镜像内端 */
  onSessionRaw(sessionId: string, chunk: Buffer): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const decision = decide(session.payload.config.rx, chunk)
    if (decision.forward) {
      session.stats.rxFwd += chunk.length
      try {
        session.port.write(chunk)
      } catch (err) {
        logger.error(`[mirror] rx write failed: ${(err as Error).message}`)
      }
    } else {
      session.stats.rxDrop += chunk.length
    }
  }

  /** 自己终端发送的数据镜像:规则判定后转发到镜像内端 */
  onSessionTx(sessionId: string, command: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const chunk = Buffer.from(command, 'latin1')
    const decision = decide(session.payload.config.ownTx, chunk)
    if (decision.forward) {
      session.stats.ownTxFwd += chunk.length
      try {
        session.port.write(chunk)
      } catch {
        /* ignore */
      }
    }
  }

  /** 镜像内端收到的数据(外端应用写入):规则判定后注入会话发往设备 */
  private onPairData(sessionId: string, chunk: Buffer): void {
    const session = this.sessions.get(sessionId)
    if (!session || !this.hooks) return
    const decision = decide(session.payload.config.inject, chunk)
    if (decision.forward) {
      session.stats.injectFwd += chunk.length
      void Promise.resolve(this.hooks.sendToSession(sessionId, chunk.toString('latin1'))).catch((err) => {
        logger.error(`[mirror] inject send failed: ${(err as Error).message}`)
      })
    } else {
      session.stats.injectDrop += chunk.length
    }
  }

  updateConfig(sessionId: string, config: MirrorConfig): { success: boolean; message?: string } {
    const session = this.sessions.get(sessionId)
    if (!session) return { success: false, message: 'mirror not active' }
    session.payload.config = config
    return { success: true }
  }

  status(): object[] {
    return Array.from(this.sessions.values()).map((s) => ({
      sessionId: s.payload.sessionId,
      comName: s.payload.comName,
      internalPort: s.payload.internalPort,
      exposedPort: s.payload.exposedPort,
      stats: s.stats
    }))
  }

  /** 会话断开时由 IpcConnector 调用,联动清理 */
  onSessionClosed(sessionId: string): void {
    if (this.sessions.has(sessionId)) void this.stop(sessionId)
  }
}
