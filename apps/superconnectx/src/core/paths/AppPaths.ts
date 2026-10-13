import { app } from 'electron'
import fs from 'fs'
import path from 'path'

export interface AppPathsOptions {
  /** Used to name the isolated Chromium session directory. */
  sessionDataName?: string
  /** Business directories created during initialization. */
  businessDirectories?: string[]
  /** Business directories that must not remain under Chromium runtime data. */
  strayRuntimeBusinessDirectories?: string[]
}

export interface AppPathLogger {
  info(message: string): void
}

const DEFAULT_OPTIONS: Required<AppPathsOptions> = {
  sessionDataName: 'superconnectx-session',
  businessDirectories: ['app-logs', 'logs', 'userdata'],
  strayRuntimeBusinessDirectories: ['userdata', 'backup', 'logs', 'app-logs']
}

const CHROMIUM_CLUTTER_PATTERNS = [
  'DawnGraphiteCache', 'DawnCache', 'GPUCache', 'blob_storage', 'Code Cache',
  'Local Storage', 'shared_proto_db', 'Network Persistent State', 'Platform Notifications',
  'TransportSecurity', 'Trust Tokens', 'Trust Tokens-journal', 'WebStorage',
  'VideoDecodeStats', 'ShaderCache', 'Crashpad', 'CrashpadMetrics-active.pma',
  'CrashpadMetrics.pma', 'First Run', 'Last Version', 'Local State', 'lockfile',
  'Variations', 'BrowserMetrics', 'component_crx_cache', 'OriginTrials', 'Safe Browsing',
  'Segmentation Platform', 'OptimizationGuidePredictionModelDownloads', 'Crowd Deny',
  'FileTypePolicies', 'FirstPartySets', 'MEIPreload', 'PKIMetadata',
  'PrivacySandboxAttestationsPreloaded', 'SafetyTips', 'SSLErrorAssistant', 'TpcdMetadata',
  'WasmTtsEngine', 'ZxcvbnData', 'hyphen-data', 'AutofillStates',
  'OnDeviceHeadSuggestModel', 'OpenCookieDatabase', 'MediaFoundationWidevineCdm', 'WidevineCdm'
]

/**
 * Owns Electron runtime paths and per-instance Chromium isolation.
 * Construct it once before `app.whenReady()`.
 */
export class AppPaths {
  private instanceIndex: number | undefined
  private instanceLockFile: string | null = null
  private readonly options: Required<AppPathsOptions>

  constructor(options: AppPathsOptions = {}) {
    this.options = {
      sessionDataName: options.sessionDataName ?? DEFAULT_OPTIONS.sessionDataName,
      businessDirectories: options.businessDirectories ?? DEFAULT_OPTIONS.businessDirectories,
      strayRuntimeBusinessDirectories:
        options.strayRuntimeBusinessDirectories ?? DEFAULT_OPTIONS.strayRuntimeBusinessDirectories
    }
  }

  getInstanceIndex(): number {
    if (this.instanceIndex !== undefined) return this.instanceIndex
    const indexArgument = process.argv.find((argument) => argument.startsWith('--instance-index='))
    const candidate = indexArgument?.split('=')[1] ?? process.env.SCX_INSTANCE_INDEX
    if (candidate !== undefined) {
      const parsed = Number.parseInt(candidate, 10)
      this.instanceIndex = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
      return this.instanceIndex
    }
    // 未显式指定(用户直接双击):自动探测空闲下标,双开的第二个实例拿到 1、2…
    // 各实例 Chromium session 目录互不相同,避免 profile 锁竞争导致的启动卡顿/白屏
    this.instanceIndex = this.acquireFreeInstanceIndex()
    return this.instanceIndex
  }

  private acquireFreeInstanceIndex(): number {
    const userData = app.getPath('userData')
    try {
      fs.mkdirSync(userData, { recursive: true })
    } catch { /* ignore */ }
    for (let index = 0; index < 32; index++) {
      const lockFile = path.join(userData, `.instance-${index}.lock`)
      try {
        fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' })
        this.instanceLockFile = lockFile
        return index
      } catch {
        if (this.isLockHolderAlive(lockFile)) continue
        try {
          fs.unlinkSync(lockFile)
          fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' })
          this.instanceLockFile = lockFile
          return index
        } catch {
          continue // 与其他实例抢占竞争失败,试下一个
        }
      }
    }
    return 0
  }

  private isLockHolderAlive(lockFile: string): boolean {
    try {
      const pid = Number.parseInt(fs.readFileSync(lockFile, 'utf8').trim(), 10)
      if (!Number.isFinite(pid) || pid <= 0) return false
      process.kill(pid, 0)
      return true
    } catch (error) {
      // EPERM:进程存在但无权限发信号,同样视为存活
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  }

  /** 退出时释放实例下标锁;进程崩溃残留的锁由 PID 存活检测自愈 */
  releaseInstanceLock(): void {
    if (!this.instanceLockFile) return
    try {
      const pid = Number.parseInt(fs.readFileSync(this.instanceLockFile, 'utf8').trim(), 10)
      if (pid === process.pid) fs.unlinkSync(this.instanceLockFile)
    } catch { /* ignore */ }
  }

  getExeDir(): string {
    let exeDir = path.dirname(app.getPath('exe'))
    if (process.platform === 'darwin') exeDir = path.resolve(exeDir, '../../..')
    return exeDir
  }

  getAppDataDir(): string {
    return app.getPath('userData')
  }

  getChromiumDataDir(): string {
    const instanceIndex = this.getInstanceIndex()
    return instanceIndex > 0
      ? path.join(this.getAppDataDir(), `_instance_${instanceIndex}`)
      : this.getAppDataDir()
  }

  overrideUserDataDirIfSet(): void {
    const directory = process.env.SCX_USER_DATA_DIR
    if (!directory) return
    try {
      app.setPath('userData', directory)
      app.setPath('sessionData', directory)
    } catch {
      // Electron may reject path changes after initialization.
    }
  }

  init(): void {
    this.overrideUserDataDirIfSet()
    const chromiumDataDir = this.getChromiumDataDir()
    const instanceSuffix = this.getInstanceIndex() > 0 ? `_${this.getInstanceIndex()}` : ''
    const sessionDataDir = path.join(this.getAppDataDir(), `${this.options.sessionDataName}${instanceSuffix}`)
    const runtimeDir = path.join(chromiumDataDir, '_runtime')

    try {
      app.setPath('sessionData', sessionDataDir)
    } catch {
      // ignore
    }
    app.commandLine.appendSwitch('disk-cache-dir', path.join(runtimeDir, 'Cache'))
    app.commandLine.appendSwitch('gpu-disk-cache-dir', path.join(runtimeDir, 'GPUCache'))
    try {
      app.setPath('crashDumps', path.join(runtimeDir, 'CrashDumps'))
    } catch {
      // ignore
    }

    for (const directory of this.options.businessDirectories) {
      fs.mkdirSync(path.join(this.getAppDataDir(), directory), { recursive: true })
    }
  }

  cleanupChromiumClutter(logger?: AppPathLogger): void {
    const chromiumDataDir = this.getChromiumDataDir()
    for (const name of CHROMIUM_CLUTTER_PATTERNS) {
      try {
        const target = path.join(chromiumDataDir, name)
        if (fs.existsSync(target)) {
          fs.rmSync(target, { recursive: true, force: true })
          logger?.info(`[AppPaths] cleaned up Chromium clutter: ${name}`)
        }
      } catch {
        // Files may still be held by Chromium.
      }
    }

    const runtimeDir = path.join(chromiumDataDir, '_runtime')
    if (fs.existsSync(runtimeDir)) {
      this.cleanupBusinessDirectories(runtimeDir, logger)
    }
  }

  private cleanupBusinessDirectories(directory: string, logger?: AppPathLogger): void {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const target = path.join(directory, entry.name)
      if (this.options.strayRuntimeBusinessDirectories.includes(entry.name)) {
        try {
          fs.rmSync(target, { recursive: true, force: true })
          logger?.info(`[AppPaths] removed stray business directory: ${target}`)
        } catch {
          // ignore
        }
      } else {
        this.cleanupBusinessDirectories(target, logger)
      }
    }
  }

}
