import os from 'os'
import { app, shell, ipcMain } from 'electron'
import logger from './IpcAppLogger'
import fs from 'fs'
import { getExeDir, getAppDataDir } from '../utils/AppDir'

const CPU_FLOAT_FIXED_SIZE = 2
const MEM_FLOAT_FIXED_SIZE = 2
const BYTE_VALUE_SIZE = 1024
const FLOAT_TO_PERCENT = 100

// 缓存上一次的 CPU 时间，用于计算差值
let prevCpuTimes: { idle: number; total: number }[] | null = null

// 缓存上一次的应用进程指标,用于差值计算应用自身 CPU 占用
let prevAppMetrics: Electron.ProcessMetric[] | null = null
let prevAppMetricsTime = 0

export default class IpcTools {
  private static sInstance: IpcTools

  constructor() {}

  static getInstance(): IpcTools {
    if (IpcTools.sInstance == null) {
      IpcTools.sInstance = new IpcTools()
    }

    return IpcTools.sInstance
  }

  init(windows): void {
    ipcMain.handle('open-devtools', () =>
      windows.mainWindow?.webContents?.isDevToolsOpened()
        ? windows.mainWindow?.webContents?.closeDevTools()
        : windows.mainWindow?.webContents?.openDevTools({ mode: 'bottom' })
    )

    ipcMain.handle('get-app-resource', async () => {
      // 系统总 CPU 占用率（通过两次采样差值计算，和任务管理器一致）
      const cpus = os.cpus()
      const curCpuTimes = cpus.map((cpu) => {
        const total = Object.values(cpu.times).reduce((a, b) => a + b, 0)
        return { idle: cpu.times.idle, total }
      })

      let cpuRate = '0.00'
      if (prevCpuTimes && prevCpuTimes.length === curCpuTimes.length) {
        const cachedTimes = prevCpuTimes
        const totalDelta = curCpuTimes.reduce((sum, cur, i) => {
          const prev = cachedTimes[i]
          const idleDelta = cur.idle - prev.idle
          const totalDelta = cur.total - prev.total
          return sum + (totalDelta > 0 ? ((totalDelta - idleDelta) / totalDelta) * 100 : 0)
        }, 0)
        cpuRate = (totalDelta / cpus.length).toFixed(CPU_FLOAT_FIXED_SIZE)
      }
      prevCpuTimes = curCpuTimes

      // 系统总内存占用率
      const totalMem = os.totalmem()
      const freeMem = os.freemem()
      const usedMem = totalMem - freeMem
      const memRate = ((usedMem / totalMem) * FLOAT_TO_PERCENT).toFixed(MEM_FLOAT_FIXED_SIZE)

      // 应用自身占用:getAppMetrics 按进程统计(主/渲染/GPU),CPU 用两次采样差值(与系统 CPU 同思路)
      const metrics = app.getAppMetrics()
      const now = Date.now()
      let appCpu = 0
      if (prevAppMetricsTime > 0 && now > prevAppMetricsTime) {
        const intervalSec = (now - prevAppMetricsTime) / 1000
        let deltaCpuSec = 0
        for (const metric of metrics) {
          const currentTotal = metric.cpu.cumulativeCPUUsage ?? 0
          const prev = prevAppMetrics?.find((item) => item.pid === metric.pid)
          deltaCpuSec += Math.max(0, currentTotal - (prev ? prev.cpu.cumulativeCPUUsage ?? 0 : currentTotal))
        }
        // cumulativeCPUUsage 单位秒;除以核心数对齐任务管理器的全核归一化口径
        appCpu = (deltaCpuSec / intervalSec) * FLOAT_TO_PERCENT / Math.max(1, os.cpus().length)
      }
      prevAppMetrics = metrics
      prevAppMetricsTime = now
      // Electron MemoryInfo 各字段单位为 KB(getAppMetrics 实测:sum*1024 === 主进程 rss 字节数)。
      // 真实物理占用 = Σ各进程专用 + 共享页只计一次(取各进程共享量的最大值,共享段基本为同一批 DLL 物理页):
      // Σ完整工作集会把框架 DLL 等共享内存按进程数重复计入;Σ专用(任务管理器默认列)则完全漏掉共享。
      let privateBytesSum = 0
      let sharedOnceEstimate = 0
      for (const metric of metrics) {
        const privKB = metric.memory?.privateBytes
        const wsKB = metric.memory?.workingSetSize ?? 0
        if (privKB != null) {
          privateBytesSum += privKB * 1024
          sharedOnceEstimate = Math.max(sharedOnceEstimate, Math.max(0, wsKB - privKB) * 1024)
        } else {
          // 非 win32 无 privateBytes,退回工作集口径
          privateBytesSum += wsKB * 1024
        }
      }
      const appMemoryBytes = privateBytesSum + sharedOnceEstimate

      return {
        cpu: cpuRate,
        memory: (usedMem / BYTE_VALUE_SIZE / BYTE_VALUE_SIZE / BYTE_VALUE_SIZE).toFixed(MEM_FLOAT_FIXED_SIZE),
        memRate: memRate,
        appCpu: appCpu.toFixed(CPU_FLOAT_FIXED_SIZE),
        appMemoryBytes,
        appPrivateBytes: privateBytesSum,
        appSharedBytes: sharedOnceEstimate,
        appMemRate: ((appMemoryBytes / totalMem) * FLOAT_TO_PERCENT).toFixed(MEM_FLOAT_FIXED_SIZE)
      }
    })

    ipcMain.handle('open-external-url', async (_, url) => await shell.openExternal(url))
    ipcMain.handle('open-app-dir', async () => await shell.openExternal(this.getAppExecutableDir()))
    ipcMain.handle('open-user-data-dir', async () => await shell.openExternal(getAppDataDir()))

    ipcMain.handle('write-file', async (_, { path: filePath, content }) => {
      try {
        fs.writeFileSync(filePath, content, 'utf-8')
        return { success: true }
      } catch (error) {
        const err = error as Error
        logger.error(`write-file failed: ${err.message}`)
        return { success: false, message: err.message }
      }
    })

    ipcMain.handle('read-file', async (_, { path: filePath }) => {
      try {
        const content = fs.readFileSync(filePath, 'utf-8')
        return { success: true, content }
      } catch (error) {
        const err = error as Error
        logger.error(`read-file failed: ${err.message}`)
        return { success: false, message: err.message }
      }
    })

    ipcMain.handle('show-item-in-folder', async (_, filePath) => {
      shell.showItemInFolder(filePath)
    })

    logger.info(`init IpcTools done`)
  }

  getAppExecutableDir(): string {
    const exeDir = getExeDir()
    if (!fs.existsSync(exeDir)) {
      logger.error(`not find exe dir: ${exeDir}`)
    }

    return exeDir
  }
}
