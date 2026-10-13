/**
 * 命令面板:用户自定义任务(步骤流)类型定义。
 * 任务 = 有序步骤列表,步骤类型:shell 命令 / 延时 / 内置动作(发数据、连接控制)。
 */

export type TaskStepType = 'shell' | 'delay' | 'builtin'

export interface TaskShellStep {
  type: 'shell'
  /** 命令行内容,按所选 shell 解释 */
  command: string
  /** 工作目录,缺省为应用数据目录 */
  cwd?: string
  /** shell 选择,默认 Windows 用 cmd,其余平台用 sh */
  shell?: 'cmd' | 'powershell' | 'bash'
  /** 输出解码(编译工具常见 GBK),默认 utf8 */
  encoding?: string
  /** 超时(ms),超时杀掉进程树并视为失败 */
  timeoutMs?: number
  /** 后台运行:启动观察期后存活即标记步骤完成,进程常驻后台(RTT Server 等),不受超时约束 */
  background?: boolean
  /** 该步失败是否终止整个任务,默认 true */
  stopOnFail?: boolean
}

export interface TaskDelayStep {
  type: 'delay'
  ms: number
}

export type TaskBuiltinAction = 'sendData' | 'connect' | 'disconnect'

export interface TaskBuiltinStep {
  type: 'builtin'
  action: TaskBuiltinAction
  /**
   * sendData/disconnect 的目标会话:
   * - 'active':当前主窗口激活的终端会话(运行时上报)
   * - 'last':本任务上一步 connect 建立的会话
   * - 其他:按串口名(如 COM20)在现有会话中匹配,匹配不到再按会话 ID
   */
  target?: string
  /** sendData:要发送的文本 */
  data?: string
  /** sendData:发送后追加 CRLF */
  appendCrlf?: boolean
  /** connect:已保存连接的存储 id(优先) */
  connectionId?: number
  /** connect:未保存连接时直接按串口名连接 */
  comName?: string
  baudRate?: number
  /** 该步失败是否终止整个任务,默认 true */
  stopOnFail?: boolean
}

export type TaskStep = TaskShellStep | TaskDelayStep | TaskBuiltinStep

export interface UserTask {
  id: string
  name: string
  group?: string
  /** 任务级重复次数,1 = 只跑一遍 */
  repeat?: number
  steps: TaskStep[]
  createdAt?: string
  updatedAt?: string
}

/** 运行期事件(主进程 → 面板窗口,经 'task:event' 通道推送) */
export type TaskRunEvent =
  | { kind: 'run-start'; runId: string; taskName: string; totalSteps: number; repeat: number }
  | { kind: 'repeat-start'; runId: string; round: number }
  | { kind: 'step-start'; runId: string; index: number; total: number; label: string }
  | { kind: 'output'; runId: string; stream: 'stdout' | 'stderr' | 'info'; text: string }
  | { kind: 'step-end'; runId: string; index: number; success: boolean; exitCode?: number; message?: string; durationMs: number }
  | { kind: 'run-end'; runId: string; success: boolean; aborted: boolean; durationMs: number }
