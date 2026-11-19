import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

/**
 * 硬件在环(HIL)测试配置:与 integration 的差别是不 mock serialport(真实开串口),
 * 仅包含需要真实硬件的用例(手动/本机运行,不进 CI):
 *   mirrorSmoke 需要 COM72(物理口)与 com0com 对 COM33/COM34,缺件自动跳过
 */
const commonAlias = {
  '@': resolve('apps/superconnectx/src'),
  electron: resolve('tests/__mocks__/electron.ts'),
  'electron-store': resolve('tests/__mocks__/electron-store.ts'),
  '../ipc/IpcAppLogger': resolve('tests/__mocks__/IpcAppLogger.ts')
}

export default defineConfig({
  test: {
    include: ['tests/integration/mirrorSmoke.test.ts'],
    environment: 'node',
    testTimeout: 30000
  },
  resolve: {
    alias: commonAlias
  }
})
