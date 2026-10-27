/**
 * IpcStorage 测试
 * 测试数据存储 IPC handler 注册和核心逻辑
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'path'
import os from 'os'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

// vitest 对 adm-zip(CJS)的 ESM 互操作会丢实例方法,用 createRequire 直取 CJS 类
const AdmZip = createRequire(import.meta.url)('adm-zip') as new () => {
  addFile: (entryName: string, content: Buffer) => void
  writeZip: (filePath: string) => void
}

const { mockHandlers, mockIpcMain, notifyTasksChangedSpy } = vi.hoisted(() => {
  const handlers = new Map<string, Function>()
  return {
    mockHandlers: handlers,
    notifyTasksChangedSpy: vi.fn(),
    mockIpcMain: {
      _handlers: handlers,
      handle(channel: string, handler: Function) {
        handlers.set(channel, handler)
      }
    }
  }
})

// IpcStorage 经 IpcTasks(notifyTasksChanged)联动面板窗口,IpcTasks 及其依赖
// (WindowStateStorage)从 electron 具名导入多个成员,mock 须提供这些导出否则 ESM 具名导入直接报错。
// app.getPath 供 scripts 导入等运行时路径解析使用
vi.mock('electron', () => ({
  ipcMain: mockIpcMain,
  app: { getPath: () => path.join(os.tmpdir(), 'scx-ipcstorage-test-userdata') },
  screen: { getDisplayMatching: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })) },
  BrowserWindow: class {}
}))

// IpcTasks 引入的 @electron-toolkit/utils 内部同样具名导入 electron 的 BrowserWindow,须一并 mock
vi.mock('@electron-toolkit/utils', () => ({
  electronApp: { setAppUserModelId: vi.fn() },
  optimizer: { watchWindowShortcuts: vi.fn() },
  is: { dev: true }
}))

vi.mock('@/main/ipc/IpcTasks', () => ({
  default: {
    getInstance() {
      return { notifyTasksChanged: notifyTasksChangedSpy }
    }
  }
}))

vi.mock('@/main/ipc/IpcAppLogger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

vi.mock('@/main/ipc/IpcConnector', () => ({
  default: { getInstance() { return { applySettings: vi.fn(), cleanup: vi.fn() } } }
}))

vi.mock('@/main/utils/BackupManager', () => ({
  default: { getInstance() { return { getBackupList: vi.fn(() => []), restoreBackup: vi.fn(), getNextBackupDate: vi.fn(() => null) } } }
}))

vi.mock('@/main/storage/ConnectionStorage', () => ({
  default: class {
    getAll() { return [] }
    add(_c: any) { return {} }
    update(_c: any) {}
    delete(_id: number) {}
    getByIdWithPassword(_id: number) { return null }
  }
}))

vi.mock('@/main/storage/PreSetCommandStorage', () => ({
  default: class {
    getAll() { return [] }
    add(_c: any) { return '' }
    update(_c: any) { return '' }
    delete(_id: number) {}
    deleteByGroupId(_g: number) {}
    exportCommands(..._a: any[]) {}
    importCommands(..._a: any[]) {}
    importFromSuperCom(..._a: any[]) {}
  }
}))

vi.mock('@/main/storage/CommandGroupStorage', () => ({
  default: class {
    getAll() { return [] }
    add(_g: any) { return {} }
    update(_g: any) { return null }
    delete(_id: number) {}
  }
}))

vi.mock('@/main/storage/ComSettingsStorage', () => ({
  default: class {
    getSettings(_n: string) { return null }
    saveSettings(..._a: any[]) {}
    getBaudRates() { return [9600, 115200] }
    saveBaudRates(_r: number[]) {}
  }
}))

vi.mock('@/main/storage/AppSettingsStorage', () => ({
  default: class {
    getSettings() { return {} }
    saveSettings(_s: any) {}
  }
}))

vi.mock('@/main/storage/SettingsStorage', () => ({
  default: class {
    getSettings() { return { syntaxRuleGroups: [] } }
    getDefaults() { return {} }
    saveSettings(_s: any) {}
  }
}))

vi.mock('@/main/storage/CommandHistoryStorage', () => ({
  default: class {
    getHistory(_p: string) { return [] }
    addCommand(..._a: any[]) {}
    clearHistory(_p: string) {}
    removeCommand(..._a: any[]) {}
    applyMaxCount(_m: number) {}
  }
}))

vi.mock('@/main/storage/ShortcutsStorage', () => ({
  default: class {
    getAll() { return [] }
    getDefaults() { return [] }
    saveAll(_s: any[]) {}
  },
  SHORTCUT_ACTIONS: [{ action: 'connect', description: '连接' }, { action: 'disconnect', description: '断开' }]
}))

vi.mock('@/main/storage/LogFilterStorage', () => ({
  default: class {
    getSettings() { return {} }
    saveSettings(_s: any) {}
  }
}))

vi.mock('archiver', () => ({
  default: function() {
    return { pipe: vi.fn(), append: vi.fn(), finalize: vi.fn(), on: vi.fn() }
  }
}))

vi.mock('adm-zip', () => ({
  default: class { getEntries() { return [] } }
}))

import IpcStorage from '@/main/ipc/IpcStorage'

describe('IpcStorage', () => {
  let ipcStorage: IpcStorage

  beforeEach(() => {
    ;(IpcStorage as any).sInstance = null
    ipcStorage = IpcStorage.getInstance()
    mockHandlers.clear()
  })

  describe('getInstance', () => {
    it('should return same instance', () => {
      expect(IpcStorage.getInstance()).toBe(IpcStorage.getInstance())
    })
  })

  describe('init() handler registration', () => {
    it('should register storage handlers', () => {
      ipcStorage.init()
      expect(mockHandlers.has('get-connections')).toBe(true)
      expect(mockHandlers.has('add-connection')).toBe(true)
      expect(mockHandlers.has('delete-connection')).toBe(true)
    })

    it('should register preset command handlers', () => {
      ipcStorage.init()
      expect(mockHandlers.has('get-preset-commands')).toBe(true)
      expect(mockHandlers.has('add-preset-command')).toBe(true)
    })

    it('should register command group handlers', () => {
      ipcStorage.init()
      expect(mockHandlers.has('get-command-groups')).toBe(true)
      expect(mockHandlers.has('add-command-group')).toBe(true)
    })

    it('should register import/export handlers', () => {
      ipcStorage.init()
      expect(mockHandlers.has('export-commands')).toBe(true)
      expect(mockHandlers.has('import-commands')).toBe(true)
      expect(mockHandlers.has('export-data')).toBe(true)
      expect(mockHandlers.has('import-data')).toBe(true)
    })

    it('should register COM settings handlers', () => {
      ipcStorage.init()
      expect(mockHandlers.has('get-com-settings')).toBe(true)
      expect(mockHandlers.has('get-baud-rates')).toBe(true)
    })

    it('should register settings handlers', () => {
      ipcStorage.init()
      expect(mockHandlers.has('get-settings')).toBe(true)
      expect(mockHandlers.has('save-settings')).toBe(true)
      expect(mockHandlers.has('get-app-settings')).toBe(true)
    })

    it('should register shortcut handlers', () => {
      ipcStorage.init()
      expect(mockHandlers.has('get-shortcuts')).toBe(true)
      expect(mockHandlers.has('get-shortcut-actions')).toBe(true)
    })

    it('should register command history handlers', () => {
      ipcStorage.init()
      expect(mockHandlers.has('get-command-history')).toBe(true)
      expect(mockHandlers.has('add-command-history')).toBe(true)
      expect(mockHandlers.has('clear-command-history')).toBe(true)
    })

    it('should register syntax highlight handlers', () => {
      ipcStorage.init()
      expect(mockHandlers.has('get-syntax-rule-groups')).toBe(true)
      expect(mockHandlers.has('save-syntax-rule-groups')).toBe(true)
    })

    it('should register backup handlers', () => {
      ipcStorage.init()
      expect(mockHandlers.has('get-backup-list')).toBe(true)
      expect(mockHandlers.has('restore-backup')).toBe(true)
    })
  })

  describe('handler behavior', () => {
    it('should return empty array for get-connections', async () => {
      ipcStorage.init()
      const result = await mockHandlers.get('get-connections')!()
      expect(Array.isArray(result)).toBe(true)
    })

    it('should save settings without error', async () => {
      ipcStorage.init()
      const result = await mockHandlers.get('save-settings')!({}, { test: 'value' })
      expect(result).toBe(true)
    })

    it('should return baud rates array', async () => {
      ipcStorage.init()
      const result = await mockHandlers.get('get-baud-rates')!()
      expect(Array.isArray(result)).toBe(true)
    })

    it('should return shortcut actions', async () => {
      ipcStorage.init()
      const result = await mockHandlers.get('get-shortcut-actions')!()
      expect(Array.isArray(result)).toBe(true)
      expect(result.length).toBeGreaterThan(0)
    })
  })

  describe('import-data 面板联动', () => {
    const makeZip = (entries: Array<[string, unknown]>): string => {
      const zip = new AdmZip()
      for (const [name, data] of entries) {
        zip.addFile(name, Buffer.from(JSON.stringify({ type: name.replace('.json', ''), data })))
      }
      const file = path.join(os.tmpdir(), `scx-import-test-${randomUUID()}.zip`)
      zip.writeZip(file)
      return file
    }

    it('导入含用户任务的 ZIP 后通知面板重载', async () => {
      ipcStorage.init()
      notifyTasksChangedSpy.mockClear()
      const file = makeZip([['userTasks.json', [{ id: randomUUID(), name: '导入的任务', steps: [] }]]])

      const result = await mockHandlers.get('import-data')!(null, file)

      expect(result.success).toBe(true)
      expect(result.userTasksImported).toBe(1)
      expect(notifyTasksChangedSpy).toHaveBeenCalledTimes(1)
    })

    it('不含用户任务的导入不触发面板通知', async () => {
      ipcStorage.init()
      notifyTasksChangedSpy.mockClear()
      const file = makeZip([['scripts.json', { 'demo.cmd': 'echo hi' }]])

      const result = await mockHandlers.get('import-data')!(null, file)

      expect(result.success).toBe(true)
      expect(notifyTasksChangedSpy).not.toHaveBeenCalled()
    })
  })
})
