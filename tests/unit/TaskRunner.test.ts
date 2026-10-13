import { describe, it, expect, beforeEach } from 'vitest'
import { TaskRunner, type TaskConnector } from '@/main/tasks/TaskRunner'
import type { UserTask, TaskRunEvent } from '@/shared/tasks/UserTask'

const makeConnector = (): TaskConnector & { calls: Array<{ op: string; arg: unknown }> } => {
  const calls: Array<{ op: string; arg: unknown }> = []
  return {
    calls,
    async sendMcpSession(sessionId: string, command: string) {
      calls.push({ op: 'send', arg: { sessionId, command } })
      return { success: true }
    },
    async stopMcpSession(sessionId: string) {
      calls.push({ op: 'stop', arg: sessionId })
      return { success: true }
    },
    async startMcpSavedSession(connectionId: number) {
      calls.push({ op: 'connect-id', arg: connectionId })
      return { success: true, sessionId: `conn-${connectionId}` }
    },
    async startMcpSerialSession(port: string, baudRate?: number) {
      calls.push({ op: 'connect-com', arg: { port, baudRate } })
      return { success: true, sessionId: `com-${port}` }
    },
    findSessionIdByComName(comName: string) {
      return comName === 'COM20' ? 'session-com20' : null
    }
  }
}

const collect = (): { events: TaskRunEvent[]; emit: (e: TaskRunEvent) => void } => {
  const events: TaskRunEvent[] = []
  return { events, emit: (e) => events.push(e) }
}

const runTask = (steps: UserTask['steps'], overrides: Partial<UserTask> = {}): UserTask => ({
  id: 't',
  name: 'test',
  steps,
  ...overrides
})

describe('TaskRunner', () => {
  let runner: TaskRunner

  beforeEach(() => {
    runner = new TaskRunner()
  })

  it('shell 步骤执行成功并输出 stdout', async () => {
    const { events, emit } = collect()
    const result = await runner.run(
      runTask([{ type: 'shell', command: 'node -e "console.log(42)"' }]),
      { activeSessionId: null, emit, connector: makeConnector() }
    )
    expect(result.success).toBe(true)
    const outputs = events.filter((e) => e.kind === 'output') as Array<{ kind: 'output'; text: string }>
    expect(outputs.some((e) => e.text.includes('42'))).toBe(true)
    const stepEnd = events.find((e) => e.kind === 'step-end') as { kind: 'step-end'; success: boolean; exitCode?: number }
    expect(stepEnd.success).toBe(true)
    expect(stepEnd.exitCode).toBe(0)
  })

  // Windows 下 external 模式会弹真实控制台窗口,单测跳过,行为由手动验证覆盖
  it.skipIf(process.platform === 'win32')('external 模式在非 Windows 回退为面板内执行', async () => {
    const { events, emit } = collect()
    const result = await runner.run(
      runTask([{ type: 'shell', command: 'node -p 42' }]),
      { activeSessionId: null, emit, connector: makeConnector(), external: true, taskName: 'T' }
    )
    expect(result.success).toBe(true)
    const outputs = events.filter((e) => e.kind === 'output') as Array<{ kind: 'output'; text: string }>
    expect(outputs.some((e) => e.text.includes('42'))).toBe(true)
  })

  it('shell 步骤失败且 stopOnFail 默认为 true 时终止任务', async () => {
    const { events, emit } = collect()
    const result = await runner.run(
      runTask([
        { type: 'shell', command: 'node -e "process.exit(3)"' },
        { type: 'shell', command: 'node -e "console.log(99)"' }
      ]),
      { activeSessionId: null, emit, connector: makeConnector() }
    )
    expect(result.success).toBe(false)
    const outputs = events.filter((e) => e.kind === 'output') as Array<{ kind: 'output'; text: string }>
    expect(outputs.some((e) => e.text.includes('99'))).toBe(false)
    const stepEnds = events.filter((e) => e.kind === 'step-end') as Array<{ kind: 'step-end'; success: boolean; exitCode?: number }>
    expect(stepEnds).toHaveLength(1)
    expect(stepEnds[0].exitCode).toBe(3)
  })

  it('stopOnFail=false 时失败后继续执行', async () => {
    const { events, emit } = collect()
    const result = await runner.run(
      runTask([
        { type: 'shell', command: 'node -e "process.exit(1)"', stopOnFail: false },
        { type: 'shell', command: 'node -e "console.log(99)"' }
      ]),
      { activeSessionId: null, emit, connector: makeConnector() }
    )
    expect(result.success).toBe(false)
    const outputs = events.filter((e) => e.kind === 'output') as Array<{ kind: 'output'; text: string }>
    expect(outputs.some((e) => e.text.includes('99'))).toBe(true)
    expect(events.filter((e) => e.kind === 'step-end')).toHaveLength(2)
  })

  it('延时步骤等待指定时间', async () => {
    const { emit } = collect()
    const started = Date.now()
    const result = await runner.run(runTask([{ type: 'delay', ms: 250 }]), {
      activeSessionId: null,
      emit,
      connector: makeConnector()
    })
    expect(result.success).toBe(true)
    expect(Date.now() - started).toBeGreaterThanOrEqual(200)
  })

  it('sendData 按 active 目标解析并发送', async () => {
    const connector = makeConnector()
    const { emit } = collect()
    const result = await runner.run(
      runTask([{ type: 'builtin', action: 'sendData', target: 'active', data: 'reset', appendCrlf: true }]),
      { activeSessionId: 'session-A', emit, connector }
    )
    expect(result.success).toBe(true)
    expect(connector.calls).toContainEqual({ op: 'send', arg: { sessionId: 'session-A', command: 'reset\r\n' } })
  })

  it('sendData 目标为串口名时按现有会话匹配', async () => {
    const connector = makeConnector()
    const { emit } = collect()
    const result = await runner.run(
      runTask([{ type: 'builtin', action: 'sendData', target: 'COM20', data: 'AT' }]),
      { activeSessionId: null, emit, connector }
    )
    expect(result.success).toBe(true)
    expect(connector.calls).toContainEqual({ op: 'send', arg: { sessionId: 'session-com20', command: 'AT' } })
  })

  it('connect 后 last 目标指向新建会话,disconnect 关闭它', async () => {
    const connector = makeConnector()
    const { emit } = collect()
    const result = await runner.run(
      runTask([
        { type: 'builtin', action: 'connect', comName: 'COM20', baudRate: 115200 },
        { type: 'builtin', action: 'sendData', target: 'last', data: 'hello' },
        { type: 'builtin', action: 'disconnect', target: 'last' }
      ]),
      { activeSessionId: null, emit, connector }
    )
    expect(result.success).toBe(true)
    expect(connector.calls).toContainEqual({ op: 'connect-com', arg: { port: 'COM20', baudRate: 115200 } })
    expect(connector.calls).toContainEqual({ op: 'send', arg: { sessionId: 'com-COM20', command: 'hello' } })
    expect(connector.calls).toContainEqual({ op: 'stop', arg: 'com-COM20' })
  })

  it('目标不存在时步骤失败并给出信息', async () => {
    const { events, emit } = collect()
    const result = await runner.run(
      runTask([{ type: 'builtin', action: 'sendData', target: 'active', data: 'x' }]),
      { activeSessionId: null, emit, connector: makeConnector() }
    )
    expect(result.success).toBe(false)
    const stepEnd = events.find((e) => e.kind === 'step-end') as { kind: 'step-end'; message?: string }
    expect(stepEnd.message).toContain('目标会话不存在')
  })

  it('任务级 repeat 重复执行', async () => {
    const connector = makeConnector()
    const { events, emit } = collect()
    const result = await runner.run(
      runTask([{ type: 'builtin', action: 'sendData', target: 'active', data: 'x' }], { repeat: 3 }),
      { activeSessionId: 's1', emit, connector }
    )
    expect(result.success).toBe(true)
    expect(connector.calls.filter((c) => c.op === 'send')).toHaveLength(3)
    expect(events.filter((e) => e.kind === 'repeat-start')).toHaveLength(3)
  })

  it('运行中拒绝第二个任务,stop 可中止', async () => {
    const first = runner.run(runTask([{ type: 'delay', ms: 5_000 }]), {
      activeSessionId: null,
      emit: () => {},
      connector: makeConnector()
    })
    expect(runner.isRunning()).toBe(true)
    await expect(
      runner.run(runTask([{ type: 'delay', ms: 10 }]), { activeSessionId: null, emit: () => {}, connector: makeConnector() })
    ).rejects.toThrow('已有任务在运行中')
    runner.stop()
    const result = await first
    expect(result.aborted).toBe(true)
    expect(result.success).toBe(false)
  })
})
