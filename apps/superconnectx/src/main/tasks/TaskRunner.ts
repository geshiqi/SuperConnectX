/**
 * 命令面板:任务执行引擎。
 * 顺序执行任务步骤(shell / 延时 / 内置动作),支持中止、stopOnFail、任务级重复。
 * 内置动作通过 IpcConnector 的会话接口完成(与 MCP 共用同一层,用户会话同样注册其中)。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as iconv from 'iconv-lite'
import type {
  TaskShellStep,
  TaskDelayStep,
  TaskBuiltinStep,
  UserTask,
  TaskRunEvent
} from '../../shared/tasks/UserTask'

/** 内置动作所需的会话能力(由 IpcConnector 提供,测试可注入替身) */
export interface TaskConnector {
  sendMcpSession(sessionId: string, command: string): Promise<object>
  stopMcpSession(sessionId: string): Promise<object>
  startMcpSavedSession(connectionId: number, ownerId?: string): Promise<object>
  startMcpSerialSession(port: string, baudRate?: number, ownerId?: string): Promise<object>
  findSessionIdByComName(comName: string): string | null
}

export interface RunOptions {
  /** 主窗口当前激活的终端会话(target: 'active' 的解析来源) */
  activeSessionId: string | null
  emit: (event: TaskRunEvent) => void
  connector: TaskConnector
  /** shell 步骤在新控制台窗口运行,输出显示在外部终端(仅 Windows) */
  external?: boolean
  /** 任务名(外部终端窗口标题用) */
  taskName?: string
}

interface StepResult {
  success: boolean
  exitCode?: number
  message?: string
}

export interface BackgroundProcessInfo {
  id: string
  name: string
  pid: number | undefined
  startedAt: number
}

const DEFAULT_CONNECT_TIMEOUT_MS = 20_000
/** 后台模式启动观察期:期间退出/报错视为步骤失败,存活则转后台常驻 */
const BACKGROUND_GRACE_MS = 2500

export class TaskRunner {
  private aborted = false
  private currentShell: ChildProcess | null = null
  private running = false
  private backgroundShells = new Map<string, { child: ChildProcess; info: BackgroundProcessInfo }>()

  isRunning(): boolean {
    return this.running
  }

  /** 中止当前任务:杀掉 shell 进程树,延时/后续步骤随之退出 */
  stop(): void {
    this.aborted = true
    this.killCurrentShell()
  }

  /** 后台常驻进程列表 */
  listBackground(): BackgroundProcessInfo[] {
    return Array.from(this.backgroundShells.values()).map((entry) => entry.info)
  }

  /** 停掉所有后台常驻进程,返回停止数量(应用退出时也会调用) */
  stopBackgroundAll(): number {
    let count = 0
    for (const [, entry] of this.backgroundShells) {
      this.killShell(entry.child)
      count++
    }
    this.backgroundShells.clear()
    return count
  }

  async run(task: UserTask, options: RunOptions): Promise<{ success: boolean; aborted: boolean }> {
    if (this.running) {
      throw new Error('已有任务在运行中')
    }
    this.running = true
    this.aborted = false
    const startedAt = Date.now()
    const repeat = task.repeat && task.repeat > 0 ? Math.floor(task.repeat) : 1
    const total = task.steps.length
    const { emit } = options

    emit({ kind: 'run-start', runId: '', taskName: task.name, totalSteps: total, repeat })

    let allSuccess = true
    try {
      for (let round = 1; round <= repeat; round++) {
        if (this.aborted) break
        if (repeat > 1) emit({ kind: 'repeat-start', runId: '', round })
        // lastSessionId 只在单轮内有效:每轮的 connect 步骤重建
        const state = { lastSessionId: null as string | null }
        for (let index = 0; index < total; index++) {
          if (this.aborted) break
          const step = task.steps[index]
          const label = this.stepLabel(step)
          emit({ kind: 'step-start', runId: '', index, total, label })
          const stepStarted = Date.now()
          let result: StepResult
          if (step.type === 'shell') result = await this.runShell(step, options)
          else if (step.type === 'delay') result = await this.runDelay(step)
          else result = await this.runBuiltin(step, options, state)
          const durationMs = Date.now() - stepStarted
          emit({
            kind: 'step-end',
            runId: '',
            index,
            success: result.success,
            exitCode: result.exitCode,
            message: result.message,
            durationMs
          })
          const stopOnFail = (step as TaskShellStep | TaskBuiltinStep).stopOnFail !== false
          if (!result.success) {
            allSuccess = false
            if (stopOnFail) {
              emit({ kind: 'output', runId: '', stream: 'info', text: `步骤失败,任务终止: ${result.message ?? ''}` })
              break
            }
          }
        }
        if (!allSuccess && this.someStepStopsOnFail(task)) break
      }
    } finally {
      this.running = false
      this.currentShell = null
    }

    const aborted = this.aborted
    emit({ kind: 'run-end', runId: '', success: allSuccess && !aborted, aborted, durationMs: Date.now() - startedAt })
    return { success: allSuccess && !aborted, aborted }
  }

  private someStepStopsOnFail(task: UserTask): boolean {
    return task.steps.some((step) => (step as TaskShellStep | TaskBuiltinStep).stopOnFail !== false)
  }

  private stepLabel(step: UserTask['steps'][number]): string {
    if (step.type === 'shell') return step.command.length > 80 ? `${step.command.slice(0, 80)}...` : step.command
    if (step.type === 'delay') return `delay ${step.ms}ms`
    if (step.action === 'sendData') return `send → ${step.target || 'active'}: ${(step.data || '').slice(0, 60)}`
    if (step.action === 'connect') return step.connectionId != null ? `connect #${step.connectionId}` : `connect ${step.comName || ''}`
    return `disconnect ${step.target || 'last'}`
  }

  // ===== shell 步骤 =====

  private buildShellCommand(step: TaskShellStep): { file: string; args: string[] } {
    const shell = step.shell || (process.platform === 'win32' ? 'cmd' : 'bash')
    if (shell === 'powershell') return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', step.command] }
    if (shell === 'bash') return { file: process.platform === 'win32' ? 'bash.exe' : '/bin/sh', args: ['-c', step.command] }
    return { file: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', args: process.platform === 'win32' ? ['/d', '/s', '/c', step.command] : ['-c', step.command] }
  }

  private async runShell(step: TaskShellStep, options: RunOptions): Promise<StepResult> {
    if (step.background) {
      return await this.runShellBackground(step, options)
    }
    if (options.external) {
      if (process.platform === 'win32') {
        return await this.runShellExternal(step, options)
      }
      options.emit({ kind: 'output', runId: '', stream: 'info', text: '外部终端模式仅支持 Windows,本步骤在面板内执行' })
    }
    const { file, args } = this.buildShellCommand(step)
    const encoding = step.encoding || 'utf8'
    const isCmd = process.platform === 'win32' && (step.shell || 'cmd') === 'cmd'
    return new Promise<StepResult>((resolve) => {
      let child: ChildProcess
      try {
        child = spawn(file, args, {
          cwd: step.cwd || undefined,
          windowsHide: true,
          shell: false,
          // cmd.exe 不识别 spawn 默认的 \" 转义;原样传参让 cmd 自己解析引号
          ...(isCmd ? { windowsVerbatimArguments: true } : {})
        })
      } catch (error) {
        return resolve({ success: false, message: `启动失败: ${(error as Error).message}` })
      }
      this.currentShell = child

      // 多字节编码的 chunk 边界保护:暂存尾部疑似不完整序列的字节
      let carry = Buffer.alloc(0)
      const decode = (buf: Buffer): string => {
        const merged = Buffer.concat([carry, buf])
        const usable = iconv.encodingExists(encoding) ? merged : merged // 未知编码退化为 utf8 由 iconv 处理
        let splitAt = usable.length
        if (/^(gb|big5|shift|euc|windows-125|iso-8859|ucs2|utf16)/i.test(encoding) || encoding.toLowerCase() === 'gbk') {
          splitAt = this.completePrefixLength(usable, encoding)
        }
        carry = Buffer.from(usable.subarray(splitAt))
        try {
          return iconv.decode(usable.subarray(0, splitAt), encoding)
        } catch {
          return usable.subarray(0, splitAt).toString('latin1')
        }
      }

      child.stdout?.on('data', (buf: Buffer) => {
        const text = decode(buf)
        if (text) options.emit({ kind: 'output', runId: '', stream: 'stdout', text })
      })
      child.stderr?.on('data', (buf: Buffer) => {
        const text = decode(buf)
        if (text) options.emit({ kind: 'output', runId: '', stream: 'stderr', text })
      })

      let settled = false
      let timer: NodeJS.Timeout | undefined
      const finish = (success: boolean, exitCode: number | undefined, message?: string) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (this.currentShell === child) this.currentShell = null
        resolve({ success, exitCode, message })
      }

      timer = step.timeoutMs && step.timeoutMs > 0
        ? setTimeout(() => {
            options.emit({ kind: 'output', runId: '', stream: 'info', text: `超时(${step.timeoutMs}ms),终止进程` })
            this.killShell(child)
            finish(false, undefined, `timeout after ${step.timeoutMs}ms`)
          }, step.timeoutMs)
        : undefined

      child.on('error', (error) => finish(false, undefined, error.message))
      child.on('close', (code) => {
        // 冲刷暂存字节
        if (carry.length > 0) {
          try {
            options.emit({ kind: 'output', runId: '', stream: 'stdout', text: iconv.decode(carry, encoding) })
          } catch { /* 忽略解码失败 */ }
          carry = Buffer.alloc(0)
        }
        if (this.aborted) finish(false, code ?? undefined, 'aborted')
        else finish(code === 0, code ?? undefined, code === 0 ? undefined : `exit code ${code}`)
      })
    })
  }

  /**
   * 后台模式:启动观察期(BACKGROUND_GRACE_MS)内退出/报错视为失败,存活则登记为
   * 后台常驻进程并立即完成步骤,释放运行槽。观察期内输出正常上报,转后台后丢弃。
   * 外部终端请求 + 后台组合时仍用隐藏进程(外部窗口无法纳入进程管理)。
   */
  private async runShellBackground(step: TaskShellStep, options: RunOptions): Promise<StepResult> {
    const { file, args } = this.buildShellCommand(step)
    const encoding = step.encoding || 'utf8'
    const isCmd = process.platform === 'win32' && (step.shell || 'cmd') === 'cmd'
    if (options.external) {
      options.emit({ kind: 'output', runId: '', stream: 'info', text: '后台模式使用隐藏进程执行,不弹外部窗口' })
    }
    return new Promise<StepResult>((resolve) => {
      let child: ChildProcess
      try {
        child = spawn(file, args, {
          cwd: step.cwd || undefined,
          windowsHide: true,
          shell: false,
          // 与前台一致:cmd.exe 不识别 spawn 默认的 \" 转义,原样传参(引号参数如 RTTSearchRanges 依赖此行为)
          ...(isCmd ? { windowsVerbatimArguments: true } : {})
        })
      } catch (error) {
        return resolve({ success: false, message: `启动失败: ${(error as Error).message}` })
      }

      const decode = (buf: Buffer): string => {
        try {
          return iconv.decode(buf, encoding)
        } catch {
          return buf.toString('latin1')
        }
      }

      let settled = false
      let drain = false
      const info: BackgroundProcessInfo = {
        id: randomUUID(),
        name: step.command.length > 60 ? `${step.command.slice(0, 60)}...` : step.command,
        pid: child.pid,
        startedAt: Date.now()
      }

      child.stdout?.on('data', (buf: Buffer) => {
        const text = decode(buf)
        if (text && !drain) options.emit({ kind: 'output', runId: '', stream: 'stdout', text })
      })
      child.stderr?.on('data', (buf: Buffer) => {
        const text = decode(buf)
        if (text && !drain) options.emit({ kind: 'output', runId: '', stream: 'stderr', text })
      })

      const fail = (message: string, exitCode?: number): void => {
        if (settled) return
        settled = true
        resolve({ success: false, exitCode, message })
      }

      child.on('error', (error) => fail(error.message))
      child.on('close', (code) => {
        // 观察期内自己退出:视为步骤失败(命令不存在/参数错等秒退场景)
        if (!settled) {
          fail(`后台进程在观察期内退出: exit code ${code ?? '?'}`, code ?? undefined)
          return
        }
        // 已转后台后的退出:从登记表移除
        this.backgroundShells.delete(info.id)
        options.emit({ kind: 'output', runId: '', stream: 'info', text: `后台进程已退出: ${info.name} (exit ${code ?? '?'})` })
      })

      setTimeout(() => {
        if (settled) return
        settled = true
        drain = true
        this.backgroundShells.set(info.id, { child, info })
        options.emit({
          kind: 'output',
          runId: '',
          stream: 'info',
          text: `进程已转后台运行 (PID ${child.pid ?? '?'}),可在面板状态栏停止`
        })
        resolve({ success: true, message: `background pid ${child.pid ?? '?'}` })
      }, BACKGROUND_GRACE_MS)
    })
  }

  /**
   * 外部终端模式(Windows):新控制台窗口运行命令,输出显示在窗口中。
   * `start /wait` 不透传退出码,改由包装脚本把 %errorlevel% 写入标记文件回收;
   * 命令结束后 pause 保持窗口可读,按键关闭才继续下一步。
   */
  private async runShellExternal(step: TaskShellStep, options: RunOptions): Promise<StepResult> {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-task-'))
    const wrapper = path.join(workDir, 'run.cmd')
    const marker = path.join(workDir, 'exit.code')
    const title = `SCX ${options.taskName || 'Task'}`
    // 注意:`> file echo %errorlevel%` 的重定向必须前置,`echo 7> file` 会把 7 当文件描述符
    fs.writeFileSync(
      wrapper,
      ['@echo off', step.command, `> "${marker}" echo %errorlevel%`, 'pause'].join('\r\n'),
      'utf8'
    )

    const cleanup = (): void => {
      try {
        fs.rmSync(workDir, { recursive: true, force: true })
      } catch { /* ignore */ }
    }

    return new Promise<StepResult>((resolve) => {
      let child: ChildProcess
      try {
        child = spawn('cmd.exe', ['/d', '/s', '/c', `start /wait "${title}" cmd /c "${wrapper}"`], {
          cwd: step.cwd || undefined,
          windowsVerbatimArguments: true,
          windowsHide: false
        })
      } catch (error) {
        cleanup()
        return resolve({ success: false, message: `启动失败: ${(error as Error).message}` })
      }
      this.currentShell = child

      options.emit({
        kind: 'output',
        runId: '',
        stream: 'info',
        text: `已在外部终端窗口「${title}」中运行,输出显示在该窗口;命令结束后按任意键关闭窗口继续`
      })

      let settled = false
      let timer: NodeJS.Timeout | undefined
      const finish = (result: StepResult): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (this.currentShell === child) this.currentShell = null
        cleanup()
        resolve(result)
      }

      if (step.timeoutMs && step.timeoutMs > 0) {
        timer = setTimeout(() => {
          options.emit({ kind: 'output', runId: '', stream: 'info', text: `超时(${step.timeoutMs}ms),终止外部终端` })
          this.killShell(child)
          finish({ success: false, message: `timeout after ${step.timeoutMs}ms` })
        }, step.timeoutMs)
      }

      child.on('error', (error) => finish({ success: false, message: error.message }))
      child.on('close', () => {
        if (this.aborted) {
          finish({ success: false, message: 'aborted' })
          return
        }
        try {
          const code = parseInt(fs.readFileSync(marker, 'utf8').trim(), 10)
          finish({ success: code === 0, exitCode: code, message: code === 0 ? undefined : `exit code ${code}` })
        } catch {
          finish({ success: false, message: '外部终端窗口提前关闭,未获取到退出码' })
        }
      })
    })
  }

  /** 简易判断:尾部字节是否可能是被切断的多字节序列首字节(仅覆盖常见 DBCS/UTF-16 场景) */
  private completePrefixLength(buffer: Buffer, encoding: string): number {
    const enc = encoding.toLowerCase()
    if (enc === 'utf16le' || enc === 'utf-16le' || enc === 'ucs2') {
      return buffer.length - (buffer.length % 2)
    }
    // DBCS(GBK/Big5/Shift-JIS/EUC 等):最后一个字节落在 lead byte 区间时可能是被切断的双字节首字节
    const last = buffer[buffer.length - 1]
    if (last >= 0x81) return buffer.length - 1
    return buffer.length
  }

  private killShell(child: ChildProcess): void {
    if (child.pid == null) return
    if (process.platform === 'win32') {
      // Windows 杀整棵进程树(cmd /c npm 之类会派生子进程)
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      } catch { /* ignore */ }
    } else {
      try {
        child.kill('SIGTERM')
      } catch { /* ignore */ }
    }
  }

  private killCurrentShell(): void {
    if (this.currentShell) this.killShell(this.currentShell)
  }

  // ===== 延时步骤 =====

  private async runDelay(step: TaskDelayStep): Promise<StepResult> {
    const ms = Math.max(0, Math.floor(step.ms || 0))
    const started = Date.now()
    while (Date.now() - started < ms) {
      if (this.aborted) return { success: false, message: 'aborted' }
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, ms - (Date.now() - started))))
    }
    return this.aborted ? { success: false, message: 'aborted' } : { success: true }
  }

  // ===== 内置动作 =====

  private resolveTarget(target: string | undefined, options: RunOptions, state: { lastSessionId: string | null }): string | null {
    if (!target || target === 'active') return options.activeSessionId
    if (target === 'last') return state.lastSessionId
    const byCom = options.connector.findSessionIdByComName(target)
    if (byCom) return byCom
    return target
  }

  private async runBuiltin(
    step: TaskBuiltinStep,
    options: RunOptions,
    state: { lastSessionId: string | null }
  ): Promise<StepResult> {
    const { connector, emit } = options
    try {
      if (step.action === 'connect') {
        let result: object
        if (step.connectionId != null) {
          result = await this.withTimeout(connector.startMcpSavedSession(step.connectionId, 'task'), DEFAULT_CONNECT_TIMEOUT_MS, 'connect')
        } else if (step.comName) {
          result = await this.withTimeout(connector.startMcpSerialSession(step.comName, step.baudRate ?? 115200, 'task'), DEFAULT_CONNECT_TIMEOUT_MS, 'connect')
        } else {
          return { success: false, message: 'connect 步骤缺少 connectionId/comName' }
        }
        const ok = (result as { success?: boolean }).success === true
        const sessionId = (result as { sessionId?: string }).sessionId ?? null
        if (ok && sessionId) state.lastSessionId = sessionId
        return { success: ok, message: ok ? sessionId ?? undefined : (result as { message?: string }).message }
      }

      if (step.action === 'sendData') {
        const sessionId = this.resolveTarget(step.target, options, state)
        if (!sessionId) return { success: false, message: `目标会话不存在: ${step.target || 'active'}` }
        const payload = step.appendCrlf ? `${step.data ?? ''}\r\n` : (step.data ?? '')
        if (!payload) return { success: false, message: 'sendData 步骤内容为空' }
        const result = await connector.sendMcpSession(sessionId, payload)
        const ok = (result as { success?: boolean }).success === true
        return { success: ok, message: ok ? undefined : (result as { message?: string }).message }
      }

      if (step.action === 'disconnect') {
        const sessionId = this.resolveTarget(step.target || 'last', options, state)
        if (!sessionId) return { success: false, message: `目标会话不存在: ${step.target || 'last'}` }
        const result = await connector.stopMcpSession(sessionId)
        if (step.target === 'last' || !step.target) state.lastSessionId = null
        const ok = (result as { success?: boolean }).success === true
        emit({ kind: 'output', runId: '', stream: 'info', text: `disconnect ${sessionId}: ${ok ? 'ok' : ((result as { message?: string }).message ?? 'failed')}` })
        return { success: ok, message: ok ? undefined : (result as { message?: string }).message }
      }

      return { success: false, message: `未知内置动作: ${(step as { action?: string }).action}` }
    } catch (error) {
      return { success: false, message: (error as Error).message }
    }
  }

  private withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} 超时(${ms}ms)`)), ms))
    ])
  }
}
