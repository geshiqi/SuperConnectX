/**
 * 镜像与连接生命周期竞态回归:
 * 断开连接时 worker 先终止,mirror 清理(enableTap->setMirrorTap->sendToWorker)
 * 不得抛错打断 IpcConnector 的 close 回调链(曾致断开按钮状态卡死)
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: { getPath: vi.fn(() => 'C:\\temp') },
  BrowserWindow: class {}
}))
vi.mock('@/main/ipc/IpcAppLogger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

import WorkerPool from '@/main/pool/WorkerPool'

describe('WorkerPool.setMirrorTap 断开竞态', () => {
  it('worker 不存在(已终止)时静默吞错,不产生未处理拒绝', async () => {
    const pool = WorkerPool.getInstance()
    // session 'ghost' 无 worker:sendToWorker reject,由 .catch 兜住
    pool.setMirrorTap('ghost-session', false)
    // 给微任务队列一个周期,若有未处理 rejection 会在此抛出/告警
    await new Promise((r) => setTimeout(r, 20))
    expect(true).toBe(true)
  })
})
