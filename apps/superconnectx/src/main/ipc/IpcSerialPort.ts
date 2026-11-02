import { app, ipcMain } from 'electron'
import { SerialPort } from 'serialport'
import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import logger from './IpcAppLogger'

/** 主进程窗口集合（仅需 mainWindow.webContents.send 能力） */
interface WindowsRef {
  mainWindow?: { webContents?: { send: (channel: string, ...args: unknown[]) => void } } | null
}

/**
 * Windows USB 物理拓扑路径批量查询(输出每行 COMxx|8.3.3.2.3):
 * 取 LocationPaths 中 PCIROOT 开头且不含 USBMI 的首条,把 USBROOT 之后每个 USB(n) 的
 * 数字点连。已实测与 finduart 输出逐口一致;蓝牙/板载口无 PCIROOT 路径,自然无输出
 */
const WINDOWS_USB_PATH_PS = `
Get-PnpDevice -Class Ports -PresentOnly | ForEach-Object {
  $com = if ($_.FriendlyName -match '\\((COM\\d+)\\)') { $Matches[1] } else { $null }
  if (-not $com) { return }
  $lp = (Get-PnpDeviceProperty -InstanceId $_.InstanceId -KeyName 'DEVPKEY_Device_LocationPaths' -ErrorAction SilentlyContinue).Data
  $pci = @($lp | Where-Object { $_ -like 'PCIROOT*' -and $_ -notlike '*USBMI*' }) | Select-Object -First 1
  if ($pci) {
    $tail = $pci -replace '^.*USBROOT\\(\\d+\\)', ''
    $nums = [regex]::Matches($tail, 'USB\\((\\d+)\\)') | ForEach-Object { $_.Groups[1].Value }
    if ($nums.Count -gt 0) { "$com|$($nums -join '.')" }
  }
}
`

export default class IpcSerialPort {
  private static sInstance: IpcSerialPort
  private windows: WindowsRef | null = null
  private hotplugTimer: NodeJS.Timeout | null = null
  private lastPortSignature = ''
  private readonly HOTPLUG_INTERVAL_MS = 2000

  constructor() {}

  static getInstance(): IpcSerialPort {
    if (IpcSerialPort.sInstance == null) {
      IpcSerialPort.sInstance = new IpcSerialPort()
    }
    return IpcSerialPort.sInstance
  }

  async listSerialPorts(logResult: boolean = true): Promise<object[]> {
    try {
      const ports = await SerialPort.list()
      if (logResult) logger.info(`serialport.list() returned ${ports.length} ports`)

      const platform = process.platform

      const filtered = ports.filter((port) => {
        const path = port.path || ''

        // Linux: keep physical serial adapters and explicitly supported GPIO/Bluetooth devices.
        if (platform === 'linux') {
          if (path.startsWith('/dev/ttyS')) {
            return !!(port.manufacturer || port.serialNumber || port.pnpId)
          }
          if (
            path.startsWith('/dev/ttyUSB') ||
            path.startsWith('/dev/ttyACM') ||
            path.startsWith('/dev/ttyAMA') ||
            path.startsWith('/dev/rfcomm')
          ) {
            return true
          }
          return false
        }

        // Windows: keep all COM ports. Software-virtualised serial ports (com0com,
        // Eltima, VSPD, etc.) are also valid ports users may want to connect to.
        if (platform === 'win32') {
          return true
        }

        // macOS: exclude Apple's virtual Bluetooth-incoming port.
        if (platform === 'darwin') {
          return !path.endsWith('.Bluetooth-Incoming-Port')
        }

        return false
      })

      // Windows: supplement with ports from registry that serialport may miss.
      // Some virtual serial port drivers (e.g. com0com) only register in
      // HKLM\HARDWARE\DEVICEMAP\SERIALCOMM but have no SetupAPI device node,
      // so SerialPort.list() won't pick them up.
      if (platform === 'win32') {
        const registryPorts = await this.getWindowsRegistryPorts(logResult)
        const existingPaths = new Set(filtered.map((p) => (p.path || '').toUpperCase()))
        for (const regPort of registryPorts) {
          if (!existingPaths.has(regPort.path.toUpperCase())) {
            filtered.push(regPort)
            existingPaths.add(regPort.path.toUpperCase())
          }
        }
      }

      const uniquePorts = filtered.filter(
        (port, index, allPorts) => allPorts.findIndex((candidate) => candidate.path === port.path) === index
      )

      // Windows:USB 物理拓扑路径(如 8.3.3.2.3)缓存补充。仅在端口集合变化或缓存超期时
      // 后台刷新(查询要起一次 PowerShell,不能跟随 2s 热插拔轮询每次执行)
      if (platform === 'win32') {
        this.refreshWindowsUsbPaths(uniquePorts.map((port) => port.path).sort().join(','))
      }

      if (logResult) logger.info(`filtered to ${uniquePorts.length} serial ports`)
      return uniquePorts.map((port) => ({
        path: port.path,
        manufacturer: port.manufacturer,
        serialNumber: port.serialNumber,
        pnpId: port.pnpId,
        locationId: port.locationId,
        usbPath: platform === 'win32' ? this.windowsUsbPaths.get((port.path || '').toUpperCase()) : undefined,
        friendlyName: port.friendlyName,
        vendorId: port.vendorId,
        productId: port.productId
      }))
    } catch (error) {
      logger.error(`list serial ports failed: ${error}`)
      return []
    }
  }

  /**
   * Windows: read COM port mappings from the registry.
   * Returns ports that serialport's SetupAPI enumeration might miss
   * (e.g. com0com virtual ports that only have a registry entry).
   * 异步执行（execFile）：热插拔轮询每 2s 触发一次，同步 execSync 会阻塞主进程
   */
  private getWindowsRegistryPorts(logResult: boolean = true): Promise<{ path: string }[]> {
    return new Promise((resolve) => {
      execFile(
        'reg',
        ['query', 'HKLM\\HARDWARE\\DEVICEMAP\\SERIALCOMM'],
        { encoding: 'utf-8', timeout: 3000, windowsHide: true },
        (error, stdout) => {
          if (error) {
            if (logResult) logger.info('registry supplement: failed to read SERIALCOMM')
            resolve([])
            return
          }
          const ports: { path: string }[] = []
          // Each line looks like: "    \\Device\\com0com10    REG_SZ    COM55"
          const re = /REG_SZ\s+(COM\d+)/gi
          let match: RegExpExecArray | null
          while ((match = re.exec(stdout)) !== null) {
            ports.push({ path: match[1] })
          }
          if (logResult) logger.info(`registry supplement: found ${ports.length} ports from SERIALCOMM`)
          resolve(ports)
        }
      )
    })
  }

  // ===== Windows USB 物理拓扑路径(如 COM72 -> 8.3.3.2.3,对齐 finduart 口径) =====
  // serialport 的 locationId 只有最后一跳(Port_#x.Hub_#y),完整链需读 SetupAPI 的
  // DEVPKEY_Device_LocationPaths。Node 无现成库直读该属性,用一次性 PowerShell 批量查询;
  // 稳态(端口集合未变)零进程开销,仅热插拔/超期时后台刷新一次

  private static readonly USB_PATH_TTL_MS = 60_000
  private readonly windowsUsbPaths = new Map<string, string>()
  private windowsUsbPathSignature = ''
  private windowsUsbPathRefreshedAt = 0
  private windowsUsbPathRefreshing = false

  /** 解析 PowerShell 输出(每行 COMxx|8.3.3.2.3);纯函数便于单测 */
  static parseWindowsUsbPathOutput(stdout: string): Map<string, string> {
    const map = new Map<string, string>()
    for (const line of stdout.split(/\r?\n/)) {
      const match = line.match(/^(COM\d+)\|([\d.]+)$/)
      if (match) map.set(match[1].toUpperCase(), match[2])
    }
    return map
  }

  private refreshWindowsUsbPaths(portSignature: string): void {
    if (this.windowsUsbPathRefreshing) return
    if (
      portSignature === this.windowsUsbPathSignature &&
      Date.now() - this.windowsUsbPathRefreshedAt < IpcSerialPort.USB_PATH_TTL_MS
    ) {
      return
    }
    this.windowsUsbPathRefreshing = true
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_USB_PATH_PS],
      { encoding: 'utf-8', timeout: 15000, windowsHide: true },
      (error, stdout) => {
        this.windowsUsbPathRefreshing = false
        this.windowsUsbPathRefreshedAt = Date.now()
        if (error) {
          // 不更新 signature:下次端口集合变化时重试
          logger.info('usb path supplement: powershell query failed')
          return
        }
        const parsed = IpcSerialPort.parseWindowsUsbPathOutput(stdout)
        const changed =
          parsed.size !== this.windowsUsbPaths.size ||
          [...parsed].some(([com, path]) => this.windowsUsbPaths.get(com) !== path)
        this.windowsUsbPaths.clear()
        for (const [com, path] of parsed) this.windowsUsbPaths.set(com, path)
        this.windowsUsbPathSignature = portSignature
        logger.info(`usb path supplement: found ${this.windowsUsbPaths.size} usb port paths`)
        // 路径就绪晚于首次列表(PowerShell 冷启数秒),端口集合未变时热插拔监听不会推送,
        // 需主动推一次带路径的列表,否则界面要等真实热插拔/手动刷新才显示
        if (changed) {
          this.listSerialPorts(false)
            .then((ports) => this.windows?.mainWindow?.webContents?.send('on-serial-ports-changed', ports))
            .catch(() => {})
        }
      }
    )
  }

  /**
   * Linux 运行时串口权限修复，面向 AppImage 等无安装钩子的包格式。
   * 通过 pkexec 弹系统授权框，以 root 执行 linux-fix-serial-permissions.sh 写入 udev 规则。
   * pkexec 返回值约定：126 = 用户取消授权对话框，127 = 未授权/pkexec 自身错误。
   */
  private fixSerialPermissions(): Promise<{ success: boolean; message?: string }> {
    if (process.platform !== 'linux') {
      return Promise.resolve({ success: false, message: '仅 Linux 支持修复串口权限' })
    }

    const scriptName = path.join('installer', 'linux-fix-serial-permissions.sh')
    const candidates = [
      process.resourcesPath ? path.join(process.resourcesPath, scriptName) : '',
      // 开发环境回退到源码目录
      path.join(app.getAppPath(), 'build', scriptName)
    ].filter(Boolean)
    const scriptPath = candidates.find((p) => fs.existsSync(p))
    if (!scriptPath) {
      logger.error('fix-serial-permissions: script not found')
      return Promise.resolve({ success: false, message: '修复脚本不存在，请手动将用户加入 dialout 用户组后注销重登' })
    }

    logger.info(`fix-serial-permissions: launching pkexec for ${scriptPath}`)
    return new Promise((resolve) => {
      execFile('pkexec', ['/bin/sh', scriptPath], { timeout: 60000 }, (error) => {
        if (!error) {
          logger.info('fix-serial-permissions: udev rules installed')
          resolve({ success: true })
          return
        }
        // spawn ENOENT 时 code 为字符串；子进程非零退出时 code 为退出码数字
        const exitCode = (error as { code?: string | number }).code
        logger.error(`fix-serial-permissions: pkexec failed: ${error.message} (code=${exitCode})`)
        if (exitCode === 'ENOENT') {
          resolve({ success: false, message: '系统缺少 pkexec，请手动执行 sudo usermod -aG dialout $USER 后注销重登' })
        } else if (exitCode === 126 || exitCode === 127) {
          resolve({ success: false, message: '授权被取消' })
        } else {
          resolve({ success: false, message: `权限修复失败：${error.message}` })
        }
      })
    })
  }

  /**
   * 启动串口热插拔监听：轮询串口列表，仅在列表变化时通知渲染进程刷新。
   * 采用轮询而非原生事件（WM_DEVICECHANGE / udev / IOKit），无需额外原生依赖，跨平台行为一致。
   */
  startHotplugWatch(): void {
    if (this.hotplugTimer) return

    // 先记录基线：渲染进程启动时会自行加载一次列表，避免启动后立即触发一次无谓刷新
    this.listSerialPorts(false)
      .then((ports) => {
        this.lastPortSignature = this.buildPortSignature(ports)
      })
      .catch(() => {})

    this.hotplugTimer = setInterval(() => {
      this.checkPortChanges().catch(() => {})
    }, this.HOTPLUG_INTERVAL_MS)
    this.hotplugTimer.unref?.() // 不阻止进程退出
    logger.info('serial port hotplug watch started')
  }

  stopHotplugWatch(): void {
    if (this.hotplugTimer) {
      clearInterval(this.hotplugTimer)
      this.hotplugTimer = null
    }
  }

  private buildPortSignature(ports: object[]): string {
    return ports
      .map((p) => (p as { path?: string }).path || '')
      .sort()
      .join('|')
  }

  private async checkPortChanges(): Promise<void> {
    const ports = await this.listSerialPorts(false)
    const signature = this.buildPortSignature(ports)
    if (signature === this.lastPortSignature) return

    const oldSignature = this.lastPortSignature
    this.lastPortSignature = signature
    logger.info(`serial ports changed: [${oldSignature}] -> [${signature}]`)
    this.windows?.mainWindow?.webContents?.send('on-serial-ports-changed', ports)
  }

  init(_logger: unknown, windows: WindowsRef): void {
    this.windows = windows

    ipcMain.handle('list-serial-ports', async () => {
      return await this.listSerialPorts()
    })

    ipcMain.handle('fix-serial-permissions', async () => {
      return await this.fixSerialPermissions()
    })

    this.startHotplugWatch()

    logger.info(`init IpcSerialPort done`)
  }
}
