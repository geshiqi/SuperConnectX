<template>
  <div class="palette">
    <!-- 标题栏:拖拽区 + 窗口控件(极简模式下隐藏,命令条兼任拖拽区) -->
    <div v-if="!minimalMode" class="palette-titlebar" @dblclick="toggleMaximize">
      <div class="title-text">{{ t('palette.title') }}</div>
      <div class="titlebar-controls">
        <button class="win-btn" :title="t('palette.enterMinimal')" @click="toggleMinimal">
          <el-icon :size="12"><Fold /></el-icon>
        </button>
        <button class="win-btn" :title="t('palette.minimize')" @click="minimizeWindow">
          <el-icon :size="12"><Minus /></el-icon>
        </button>
        <button class="win-btn" :title="isMaximized ? t('palette.restore') : t('palette.maximize')" @click="toggleMaximize">
          <el-icon :size="12"><FullScreen /></el-icon>
        </button>
        <button class="win-btn close-btn" :title="t('palette.close')" @click="closeWindow">
          <el-icon :size="14"><Close /></el-icon>
        </button>
      </div>
    </div>

    <!-- 极简模式:组下拉 + 当前组任务运行按钮 + 状态 -->
    <div v-if="minimalMode" class="minimal-bar">
      <el-select v-model="activeGroup" size="small" class="minimal-group">
        <el-option v-for="group in taskGroups" :key="group.name" :label="`${group.name || t('palette.groupUngrouped')} (${group.tasks.length})`" :value="group.name" />
      </el-select>
      <div class="minimal-tasks">
        <el-button
          v-for="task in minimalGroupTasks"
          :key="task.id"
          size="small"
          class="minimal-task-btn"
          :type="isRunning && runningTaskName === task.name ? 'primary' : 'default'"
          :disabled="isRunning && runningTaskName !== task.name"
          @click="runTask(task)"
        >
          <el-icon v-if="isRunning && runningTaskName === task.name" class="spin"><Loading /></el-icon>
          <el-icon v-else><CaretRight /></el-icon>
          {{ task.name }}
        </el-button>
        <span v-if="minimalGroupTasks.length === 0" class="minimal-empty">{{ t('palette.minimalNoTasks') }}</span>
      </div>
      <span v-if="isRunning" class="minimal-status run"><el-icon class="spin"><Loading /></el-icon></span>
      <span v-else-if="lastRunStatus" class="minimal-status" :class="lastRunStatus.success ? 'ok' : 'fail'">{{ lastRunStatus.success ? '✓' : '✗' }}</span>
      <span class="minimal-controls">
        <button class="win-btn" :title="t('palette.exitMinimal')" @click="toggleMinimal">
          <el-icon :size="12"><Expand /></el-icon>
        </button>
        <button class="win-btn close-btn" :title="t('palette.close')" @click="closeWindow">
          <el-icon :size="12"><Close /></el-icon>
        </button>
      </span>
    </div>

    <!-- 极简输出区:限高滚动,只保留最近输出 -->
    <div v-if="minimalMode" class="minimal-output" ref="outputBodyRef">
      <div v-for="(line, i) in minimalOutputLines" :key="i" class="output-line" :class="line.kind">{{ line.text }}</div>
    </div>

    <!-- 完整模式 -->
    <template v-else>
    <!-- 搜索框 -->
    <div class="search-row">
      <el-input
        ref="searchInputRef"
        v-model="keyword"
        :placeholder="t('palette.searchPlaceholder')"
        size="default"
        clearable
        @keydown.down.prevent="moveSelection(1)"
        @keydown.up.prevent="moveSelection(-1)"
        @keydown.enter.prevent="runSelected"
      >
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
      <el-dropdown trigger="click" @command="setRunMode">
        <el-button text size="default" class="run-mode-btn" :title="t('palette.runMode')">
          <el-icon><Setting /></el-icon>
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="single" :icon="runMode === 'single' ? Check : undefined">{{ t('palette.runSingle') }}</el-dropdown-item>
            <el-dropdown-item command="double" :icon="runMode === 'double' ? Check : undefined">{{ t('palette.runDouble') }}</el-dropdown-item>
            <el-dropdown-item command="button" :icon="runMode === 'button' ? Check : undefined">{{ t('palette.runButton') }}</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <el-button type="primary" size="default" @click="openEditor(null)">
        <el-icon style="margin-right: 4px"><Plus /></el-icon>{{ t('palette.newTask') }}
      </el-button>
    </div>

    <!-- 任务列表:顶部组标签切换,组内拖拽排序;搜索时跨组显示匹配 -->
    <div class="task-list" ref="taskListRef">
      <div class="group-tabs">
        <div
          v-for="group in taskGroups"
          :key="group.name"
          class="group-tab"
          :class="{ active: activeGroup === group.name }"
          :title="t('palette.tabDropHint')"
          @click="activeGroup = group.name"
          @dragover.prevent="onTabDragOver($event)"
          @dragleave="onTabDragLeave($event)"
          @drop.stop.prevent="onDropOnTab(group, $event)"
        >
          <span class="tab-name">{{ group.name || t('palette.groupUngrouped') }}</span>
          <span class="tab-count">{{ group.tasks.length }}</span>
        </div>
      </div>
      <div v-if="currentTasks.length === 0" class="empty-hint">{{ t('palette.noTasks') }}</div>
      <div
        v-for="(task, i) in currentTasks"
        :key="task.id"
        class="task-item"
        :class="{ active: i === selectedIndex }"
        :draggable="isDragEnabled"
        :title="isDragEnabled ? t('palette.reorderHint') : ''"
        @dragstart="onDragStart(task, $event)"
        @dragover.prevent="onDragOver($event)"
        @dragleave="onDragLeave($event)"
        @drop.stop="onDropBefore(task, $event)"
        @dragend="dragTaskId = null"
        @mouseenter="selectedIndex = i"
        @click="onTaskClick(task)"
        @dblclick="onTaskDblClick(task)"
      >
        <div class="task-main">
          <span class="task-name">{{ task.name }}</span>
          <el-tag v-if="keyword && task.group" size="small" type="info">{{ task.group }}</el-tag>
          <span class="task-meta">{{ task.steps.length }} {{ t('palette.stepsUnit') }}<template v-if="(task.repeat || 1) > 1"> × {{ task.repeat }}</template></span>
        </div>
        <div class="task-actions" @click.stop>
          <el-button size="small" text type="primary" :disabled="isRunning" @click="runTask(task)">
            <el-icon><CaretRight /></el-icon>
          </el-button>
          <el-button
            size="small"
            text
            type="success"
            :disabled="isRunning"
            :title="t('palette.runExternal')"
            @click="runTask(task, true)"
          >
            <el-icon><Monitor /></el-icon>
          </el-button>
          <el-button size="small" text :title="t('palette.copyTask')" @click="duplicateTask(task)">
            <el-icon><CopyDocument /></el-icon>
          </el-button>
          <el-button size="small" text @click="openEditor(task)">
            <el-icon><Edit /></el-icon>
          </el-button>
          <el-button size="small" text type="danger" @click="removeTask(task)">
            <el-icon><Delete /></el-icon>
          </el-button>
        </div>
      </div>
    </div>

    <!-- 输出区高度拖拽条 -->
    <div
      class="output-splitter"
      title="拖拽调整输出区高度(双击复位)"
      @mousedown="startResize"
      @dblclick="resetOutputHeight"
    ></div>

    <!-- 输出区 -->
    <div class="output-panel" :style="outputPanelStyle">
      <div class="output-header">
        <span class="status">
          <template v-if="isRunning">
            <el-icon class="spin"><Loading /></el-icon>
            {{ runningTaskName }}{{ currentStepLabel ? ` · ${currentStepLabel}` : '' }}
          </template>
          <template v-else-if="lastRunStatus">
            <span :class="lastRunStatus.success ? 'ok' : 'fail'">{{ lastRunStatus.success ? '✓' : '✗' }}</span>
            {{ lastRunStatus.text }}
          </template>
          <template v-else>{{ t('palette.outputIdle') }}</template>
        </span>
        <div class="output-actions">
          <el-button
            v-if="backgroundProcs.length > 0"
            size="small"
            type="warning"
            :title="backgroundProcs.map((proc) => `${proc.name} (PID ${proc.pid ?? '?'})`).join('\n')"
            @click="stopBackground"
          >
            {{ t('palette.backgroundCount', { count: backgroundProcs.length }) }}
          </el-button>
          <el-button v-if="isRunning" size="small" type="danger" @click="stopRun">
            <el-icon style="margin-right: 3px"><VideoPause /></el-icon>{{ t('palette.stop') }}
          </el-button>
          <el-button size="small" text @click="clearOutput">{{ t('palette.clear') }}</el-button>
        </div>
      </div>
      <div class="output-body" ref="outputBodyRef">
        <div v-for="(line, i) in outputLines" :key="i" class="output-line" :class="line.kind">{{ line.text }}</div>
      </div>
    </div>

    </template>

    <!-- 任务编辑对话框(两种模式共用) -->
    <TaskEditor v-model="editorVisible" :task="editingTask" :default-group="editorDefaultGroup" @saved="onTaskSaved" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessageBox } from 'element-plus'
import { useTheme } from '@superx/foundation/theme/useTheme'
import { Check } from '@element-plus/icons-vue'
import type { UserTask, TaskRunEvent } from '../../../shared/tasks/UserTask'
import TaskEditor from './TaskEditor.vue'

const { t } = useI18n()

// 主题:优先取主窗口经主进程中继的主题,保持与主窗口皮肤同步
const themeCtl = useTheme()
let removeThemeListener: (() => void) | null = null

const tasks = ref<UserTask[]>([])
const keyword = ref('')
const selectedIndex = ref(0)
const searchInputRef = ref()
const outputBodyRef = ref()

const isRunning = ref(false)
const runningTaskName = ref('')
const currentStepLabel = ref('')
const lastRunStatus = ref<{ success: boolean; text: string } | null>(null)

interface OutputLine {
  kind: 'stdout' | 'stderr' | 'info' | 'step'
  text: string
}
const outputLines = ref<OutputLine[]>([])

const editorVisible = ref(false)
const editingTask = ref<UserTask | null>(null)

const filteredTasks = computed(() => {
  const key = keyword.value.trim().toLowerCase()
  if (!key) return tasks.value
  return tasks.value.filter(
    (task) =>
      task.name.toLowerCase().includes(key) ||
      (task.group || '').toLowerCase().includes(key)
  )
})

// ===== 组标签:按任务数组顺序首次出现分组;搜索时跨组显示匹配 =====
const activeGroup = ref<string>('')

const taskGroups = computed<Array<{ name: string; tasks: UserTask[] }>>(() => {
  const groups: Array<{ name: string; tasks: UserTask[] }> = []
  const byName = new Map<string, { name: string; tasks: UserTask[] }>()
  for (const task of tasks.value) {
    const name = task.group || ''
    let group = byName.get(name)
    if (!group) {
      group = { name, tasks: [] }
      byName.set(name, group)
      groups.push(group)
    }
    group.tasks.push(task)
  }
  return groups
})

// 当前展示的任务:搜索时跨组显示匹配,否则显示选中组的任务
const currentTasks = computed<UserTask[]>(() => {
  const key = keyword.value.trim().toLowerCase()
  if (key) return filteredTasks.value
  return taskGroups.value.find((group) => group.name === activeGroup.value)?.tasks ?? []
})

// 选中组失效(组内任务清空/改组)时回退到第一个组
watch(taskGroups, (groups) => {
  if (!groups.some((group) => group.name === activeGroup.value)) {
    activeGroup.value = groups[0]?.name ?? ''
  }
}, { immediate: true })

// ===== 运行触发模式:单击 / 双击 / 仅按钮(防误触),Enter 始终可运行 =====
type RunMode = 'single' | 'double' | 'button'
const RUN_MODE_KEY = 'palette-run-mode'
const runMode = ref<RunMode>('double')
try {
  const saved = localStorage.getItem(RUN_MODE_KEY)
  if (saved === 'single' || saved === 'double' || saved === 'button') runMode.value = saved
} catch { /* ignore */ }

const setRunMode = (mode: string | number | object): void => {
  const next = String(mode) as RunMode
  if (next !== 'single' && next !== 'double' && next !== 'button') return
  runMode.value = next
  try {
    localStorage.setItem(RUN_MODE_KEY, next)
  } catch { /* ignore */ }
}

const onTaskClick = (task: UserTask): void => {
  if (runMode.value === 'single') runTask(task)
}

const onTaskDblClick = (task: UserTask): void => {
  if (runMode.value === 'double') runTask(task)
}

// ===== 组内拖拽排序:搜索态禁用 =====
const isDragEnabled = computed(() => !keyword.value.trim())
const dragTaskId = ref<string | null>(null)

const onDragStart = (task: UserTask, event: DragEvent): void => {
  dragTaskId.value = task.id
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', task.id)
  }
}

const onDragOver = (event: DragEvent): void => {
  if (!dragTaskId.value) return
  ;(event.currentTarget as HTMLElement).classList.add('drop-hover')
}

const onDragLeave = (event: DragEvent): void => {
  ;(event.currentTarget as HTMLElement).classList.remove('drop-hover')
}

const onTabDragOver = (event: DragEvent): void => {
  if (!dragTaskId.value) return
  ;(event.currentTarget as HTMLElement).classList.add('drop-hover')
}

const onTabDragLeave = (event: DragEvent): void => {
  ;(event.currentTarget as HTMLElement).classList.remove('drop-hover')
}

/** 拖到组标签释放:任务改归该组并置于组末尾 */
const onDropOnTab = (group: { name: string }, event: DragEvent): void => {
  ;(event.currentTarget as HTMLElement).classList.remove('drop-hover')
  const dragId = dragTaskId.value
  dragTaskId.value = null
  if (!dragId) return
  const list = [...tasks.value]
  const from = list.findIndex((task) => task.id === dragId)
  if (from < 0) return
  const [moved] = list.splice(from, 1)
  const target = group.name
  moved.group = target ? target : undefined
  let insertAt = list.length
  for (let i = list.length - 1; i >= 0; i--) {
    if ((list[i].group || '') === target) {
      insertAt = i + 1
      break
    }
  }
  list.splice(insertAt, 0, moved)
  tasks.value = list
  void persistReorder()
}

/** 组内重排:把拖动任务移到目标任务之前,写回该组在数组中占用的索引位(支持与其他组交错存储) */
const onDropBefore = (target: UserTask, event: DragEvent): void => {
  event.preventDefault()
  ;(event.currentTarget as HTMLElement).classList.remove('drop-hover')
  const dragId = dragTaskId.value
  if (!dragId || dragId === target.id) return
  const groupName = activeGroup.value
  const groupTasks = tasks.value.filter((task) => (task.group || '') === groupName)
  const from = groupTasks.findIndex((task) => task.id === dragId)
  if (from < 0) return
  const [moved] = groupTasks.splice(from, 1)
  const insertAt = groupTasks.findIndex((task) => task.id === target.id)
  if (insertAt < 0) return
  groupTasks.splice(insertAt, 0, moved)

  const list = [...tasks.value]
  const positions: number[] = []
  list.forEach((task, index) => {
    if ((task.group || '') === groupName) positions.push(index)
  })
  positions.forEach((position, k) => {
    list[position] = groupTasks[k]
  })
  tasks.value = list
  void persistReorder()
}

const persistReorder = async (): Promise<void> => {
  const ids = tasks.value.map((task) => task.id)
  const groups: Record<string, string> = {}
  for (const task of tasks.value) groups[task.id] = task.group || ''
  const result = await window.taskApi.reorder(ids, groups)
  if (result.tasks) tasks.value = result.tasks
}

const ANSI_STRIP = /\u001b\[[0-9;]*[A-Za-z]/g

const appendOutput = (text: string, kind: OutputLine['kind']): void => {
  const clean = text.replace(ANSI_STRIP, '')
  if (!clean) return
  const scroll = () => {
    nextTick(() => {
      const body = outputBodyRef.value
      if (body) body.scrollTop = body.scrollHeight
    })
  }
  for (const raw of clean.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line === '' && outputLines.value.length === 0) continue
    outputLines.value.push({ kind, text: line })
  }
  if (outputLines.value.length > 5000) outputLines.value.splice(0, outputLines.value.length - 5000)
  scroll()
}

let removeListener: (() => void) | null = null

const handleEvent = (event: TaskRunEvent): void => {
  switch (event.kind) {
    case 'run-start':
      isRunning.value = true
      runningTaskName.value = event.taskName
      currentStepLabel.value = ''
      outputLines.value = []
      appendOutput(`▶ ${event.taskName}(${event.totalSteps} ${t('palette.stepsUnit')}${event.repeat > 1 ? `, ×${event.repeat}` : ''})`, 'step')
      break
    case 'repeat-start':
      appendOutput(`— ${t('palette.repeatRound')} ${event.round} —`, 'step')
      break
    case 'step-start':
      currentStepLabel.value = event.label
      appendOutput(`[${event.index + 1}/${event.total}] ${event.label}`, 'step')
      break
    case 'output':
      appendOutput(event.text, event.stream)
      break
    case 'step-end': {
      const suffix = event.success
        ? ` ✓ (${event.durationMs}ms)`
        : ` ✗ ${event.message ?? ''} (${event.durationMs}ms)`
      appendOutput(`${t('palette.stepFinished')}${suffix}`, event.success ? 'step' : 'stderr')
      break
    }
    case 'run-end':
      isRunning.value = false
      runningTaskName.value = ''
      currentStepLabel.value = ''
      lastRunStatus.value = {
        success: event.success,
        text: event.aborted
          ? `${t('palette.aborted')} (${event.durationMs}ms)`
          : `${event.success ? t('palette.success') : t('palette.failed')} · ${event.durationMs}ms`
      }
      appendOutput(event.aborted ? `■ ${t('palette.aborted')}` : event.success ? `■ ${t('palette.success')}` : `■ ${t('palette.failed')}`, 'step')
      break
  }
}

const loadTasks = async (): Promise<void> => {
  try {
    tasks.value = await window.taskApi.list()
  } catch (error) {
    console.error('failed to load tasks:', error)
  }
}

const runTask = async (task: UserTask, external = false): Promise<void> => {
  if (isRunning.value) return
  const result = await window.taskApi.run(task.id, { external })
  if (!result.success && result.message) {
    appendOutput(result.message, 'stderr')
  }
}

const runSelected = (): void => {
  const task = currentTasks.value[selectedIndex.value]
  if (task) runTask(task)
}

const moveSelection = (delta: number): void => {
  const total = currentTasks.value.length
  if (total === 0) return
  selectedIndex.value = (selectedIndex.value + delta + total) % total
}

const stopRun = async (): Promise<void> => {
  await window.taskApi.stop()
}

// ===== 后台常驻进程 =====
interface BackgroundProc {
  id: string
  name: string
  pid?: number
  startedAt: number
}
const backgroundProcs = ref<BackgroundProc[]>([])
let backgroundTimer: ReturnType<typeof setInterval> | null = null

const refreshBackground = async (): Promise<void> => {
  try {
    backgroundProcs.value = await window.taskApi.listBackground()
  } catch { /* ignore */ }
}

const stopBackground = async (): Promise<void> => {
  const result = await window.taskApi.stopBackground()
  if (result.stopped > 0) {
    appendOutput(`${t('palette.backgroundStopped', { count: result.stopped })}`, 'info')
  }
  await refreshBackground()
}

const clearOutput = (): void => {
  outputLines.value = []
  lastRunStatus.value = null
}

/** 复制任务:深拷贝步骤,同组生成副本 */
const duplicateTask = async (task: UserTask): Promise<void> => {
  const copy: UserTask = {
    ...task,
    id: '',
    name: `${task.name}${t('palette.copySuffix')}`,
    steps: JSON.parse(JSON.stringify(task.steps)) as UserTask['steps']
  }
  const result = await window.taskApi.save(copy)
  if (result.success && result.tasks) {
    tasks.value = result.tasks
    appendOutput(`${t('palette.copyTask')}: ${copy.name}`, 'info')
  } else if (result.message) {
    appendOutput(result.message, 'stderr')
  }
}

const removeTask = async (task: UserTask): Promise<void> => {
  try {
    await ElMessageBox.confirm(t('palette.deleteConfirm', { name: task.name }), t('palette.deleteTitle'), {
      type: 'warning'
    })
  } catch {
    return
  }
  const result = await window.taskApi.delete(task.id)
  if (result.tasks) tasks.value = result.tasks
}

const editorDefaultGroup = ref('')
const openEditor = (task: UserTask | null): void => {
  editingTask.value = task
  editorDefaultGroup.value = task ? task.group || '' : activeGroup.value
  editorVisible.value = true
}

const onTaskSaved = (updated: UserTask[]): void => {
  tasks.value = updated
}

const closeWindow = (): void => {
  window.close()
}

// ===== 极简模式:置顶小条(组下拉 + 任务运行按钮);runningTaskName 复用输出区已有状态 =====
const minimalMode = ref(false)

const toggleMinimal = async (): Promise<void> => {
  const next = !minimalMode.value
  minimalMode.value = next
  if (next) {
    keyword.value = ''
    // 等命令条渲染完成后实测内容自然宽度:bar 是块级容器会被拉伸到窗口宽,
    // scrollWidth 下限即自身宽度(等于旧面板宽),须临时 width:max-content 取内容宽
    await nextTick()
    const bar = document.querySelector('.minimal-bar') as HTMLElement | null
    let width: number | undefined
    if (bar) {
      const prev = bar.style.width
      bar.style.width = 'max-content'
      width = Math.min(Math.ceil(bar.offsetWidth) + 6, Math.max(window.screen.availWidth - 40, 300))
      bar.style.width = prev
    }
    await window.paletteApi?.setMinimal?.(true, width)
  } else {
    await window.paletteApi?.setMinimal?.(false)
  }
}

const minimalGroupTasks = computed<UserTask[]>(() =>
  taskGroups.value.find((group) => group.name === activeGroup.value)?.tasks ?? []
)

const minimalOutputLines = computed<OutputLine[]>(() => outputLines.value.slice(-200))

// ===== 窗口控件:最小化/最大化还原/关闭 =====
const isMaximized = ref(false)

const minimizeWindow = (): void => {
  window.paletteApi?.minimize()
}

const toggleMaximize = (): void => {
  window.paletteApi?.toggleMaximize()
}

let removeMaximizedListener: (() => void) | null = null

// ===== 输出区高度拖拽 =====
const OUTPUT_HEIGHT_KEY = 'palette-output-height'
const OUTPUT_MIN = 100

const outputHeight = ref<number | null>(null)
try {
  const saved = Number(localStorage.getItem(OUTPUT_HEIGHT_KEY))
  if (saved >= OUTPUT_MIN) outputHeight.value = saved
} catch { /* ignore */ }

// 窗口变小后夹住上限,避免输出区把任务列表挤没
const outputPanelStyle = computed(() => {
  if (outputHeight.value == null) return {}
  const max = Math.max(OUTPUT_MIN, window.innerHeight - 170)
  return { height: `${Math.min(outputHeight.value, max)}px`, flex: 'none' }
})

const onResizeMove = (e: MouseEvent): void => {
  // 拖拽条在窗口坐标系内,输出区高度 = 窗口底边到拖拽条的距离
  const height = Math.min(Math.max(window.innerHeight - e.clientY - 6, OUTPUT_MIN), window.innerHeight - 170)
  outputHeight.value = height
}

const stopResize = (): void => {
  document.removeEventListener('mousemove', onResizeMove)
  document.removeEventListener('mouseup', stopResize)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  if (outputHeight.value != null) {
    try {
      localStorage.setItem(OUTPUT_HEIGHT_KEY, String(Math.round(outputHeight.value)))
    } catch { /* ignore */ }
  }
}

const startResize = (e: MouseEvent): void => {
  if (e.button !== 0) return
  document.addEventListener('mousemove', onResizeMove)
  document.addEventListener('mouseup', stopResize)
  document.body.style.cursor = 'row-resize'
  document.body.style.userSelect = 'none'
}

const resetOutputHeight = (): void => {
  outputHeight.value = null
  try {
    localStorage.removeItem(OUTPUT_HEIGHT_KEY)
  } catch { /* ignore */ }
}

watch(currentTasks, () => {
  if (selectedIndex.value >= currentTasks.value.length) selectedIndex.value = 0
})

onMounted(async () => {
  removeListener = window.taskApi.onTaskEvent(handleEvent)
  removeMaximizedListener = window.paletteApi?.onMaximizedChanged?.((maximized) => {
    isMaximized.value = maximized
  }) ?? null
  isMaximized.value = await window.paletteApi?.isMaximized?.()
  const relayedTheme = await window.paletteApi?.getTheme?.()
  if (relayedTheme === 'light' || relayedTheme === 'dark') {
    themeCtl.applyTheme(relayedTheme)
  }
  removeThemeListener = window.paletteApi?.onThemeChanged?.((theme) => {
    if (theme === 'light' || theme === 'dark') themeCtl.applyTheme(theme)
  }) ?? null
  await loadTasks()
  // 恢复上次运行状态显示(应用重启后面板是独立会话,不恢复历史输出)
  isRunning.value = await window.taskApi.isRunning()
  await refreshBackground()
  backgroundTimer = setInterval(refreshBackground, 5000)
  searchInputRef.value?.focus?.()
})

onUnmounted(() => {
  removeListener?.()
  removeMaximizedListener?.()
  removeThemeListener?.()
  if (backgroundTimer) clearInterval(backgroundTimer)
})
</script>

<style scoped>
.palette {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg-primary, #1e1e1e);
  color: var(--text-white, #ccc);
  font-size: 13px;
  overflow: hidden;
}

.palette-titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 34px;
  padding: 0 6px 0 12px;
  -webkit-app-region: drag;
  background: var(--bg-titlebar, #2d2d30);
  flex-shrink: 0;
}

.title-text {
  font-weight: 600;
  font-size: 12px;
  color: var(--text-white, #ccc);
}

.titlebar-controls {
  display: flex;
  -webkit-app-region: no-drag;
}

.win-btn {
  width: 30px;
  height: 26px;
  background: none;
  border: none;
  color: var(--text-white, #ccc);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color 0.2s;
}

.win-btn:hover {
  background-color: var(--overlay-hover, #4a4a4d);
}

.win-btn.close-btn:hover {
  background-color: var(--btn-close-hover, #e81123);
  color: #fff;
}

.close-btn {
  width: 28px;
  height: 26px;
  background: none;
  border: none;
  color: var(--text-white, #ccc);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  -webkit-app-region: no-drag;
}

.close-btn:hover {
  background-color: var(--btn-close-hover, #e81123);
  color: #fff;
}

.search-row {
  display: flex;
  gap: 8px;
  padding: 10px 12px 6px;
  flex-shrink: 0;
}

.task-list {
  flex: 1.2;
  min-height: 80px;
  overflow-y: auto;
  padding: 0 12px 8px;
}

.empty-hint {
  color: var(--text-secondary, #888);
  text-align: center;
  padding: 24px 0;
}

.run-mode-btn {
  color: var(--text-secondary, #888);
  padding: 6px;
}

.run-mode-btn:hover {
  color: var(--focus-border-color, #409eff);
  background: var(--overlay-hover, #37373d);
}

.minimal-bar {
  flex: none;
  height: 36px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 4px 0 8px;
  overflow: hidden;
  -webkit-app-region: drag;
  background: var(--bg-titlebar, #2d2d30);
  flex-shrink: 0;
}

/* 命令条本身是窗口拖拽区,交互元素排除 */
.minimal-bar :deep(.el-select),
.minimal-bar :deep(.el-button),
.minimal-status,
.minimal-controls {
  -webkit-app-region: no-drag;
}

.minimal-bar :deep(.el-button + .el-button) {
  margin-left: 0;
}

.minimal-bar :deep(.el-button) {
  padding: 4px 8px;
}

.minimal-controls {
  display: flex;
  margin-left: auto;
}

.minimal-group {
  width: 150px;
  flex-shrink: 0;
}

.minimal-tasks {
  display: flex;
  align-items: center;
  gap: 6px;
  overflow-x: auto;
  min-width: 0;
}

.minimal-task-btn {
  flex-shrink: 0;
}

.minimal-empty {
  color: var(--text-secondary, #888);
  font-size: 12px;
}

.minimal-status {
  flex-shrink: 0;
  font-weight: 700;
}

.minimal-output {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 10px;
  border-top: 1px solid var(--border-secondary, #404040);
  font-family: 'Cascadia Mono', Consolas, 'Courier New', monospace;
  font-size: 11px;
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-all;
}

.minimal-status.ok { color: #4caf50; }
.minimal-status.fail { color: #f44336; }
.minimal-status.run { color: var(--focus-border-color, #409eff); }

.group-tabs {
  display: flex;
  gap: 6px;
  padding: 2px 0 6px;
  overflow-x: auto;
  flex-shrink: 0;
}

.group-tab {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  border-radius: 12px;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  color: var(--text-secondary, #888);
  background: var(--bg-titlebar, #2d2d30);
  font-size: 12px;
}

.group-tab:hover {
  background: var(--overlay-hover, #37373d);
}

.group-tab.active {
  background: var(--focus-border-color, #409eff);
  color: #fff;
}

.group-tab .tab-count {
  background: rgba(127, 127, 127, 0.35);
  border-radius: 8px;
  padding: 0 6px;
  font-size: 11px;
}

.group-tab.drop-hover {
  box-shadow: inset 0 -2px 0 0 var(--focus-border-color, #409eff);
  color: var(--focus-border-color, #409eff);
}

.group-tab.active .tab-count {
  background: rgba(255, 255, 255, 0.25);
}

.task-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: grab;
}

.task-item:active {
  cursor: grabbing;
}

.task-item.drop-hover {
  box-shadow: inset 0 2px 0 0 var(--focus-border-color, #409eff);
}

.task-item:hover,
.task-item.active {
  background: var(--overlay-hover, #37373d);
}

.task-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.task-name {
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.task-meta {
  color: var(--text-secondary, #888);
  font-size: 12px;
  white-space: nowrap;
}

.task-actions {
  display: flex;
  flex-shrink: 0;
}

.output-panel {
  flex: 1;
  min-height: 120px;
  display: flex;
  flex-direction: column;
}

.output-splitter {
  height: 6px;
  flex-shrink: 0;
  cursor: row-resize;
  background: var(--bg-titlebar, #2d2d30);
  border-top: 1px solid var(--border-secondary, #404040);
  position: relative;
}

.output-splitter::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 2px;
  transform: translateX(-50%);
  width: 36px;
  height: 2px;
  border-radius: 1px;
  background: var(--text-secondary, #6a6a6a);
}

.output-splitter:hover::after {
  background: var(--focus-border-color, #409eff);
}

.output-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  background: var(--bg-titlebar, #2d2d30);
  flex-shrink: 0;
}

.status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.status .ok { color: #4caf50; }
.status .fail { color: #f44336; }

.spin {
  animation: palette-spin 1s linear infinite;
}

@keyframes palette-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.output-actions {
  display: flex;
  gap: 6px;
}

.output-body {
  flex: 1;
  overflow-y: auto;
  padding: 6px 12px;
  font-family: 'Cascadia Mono', Consolas, 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}

.output-line.stderr { color: #f48771; }
.output-line.info { color: var(--focus-border-color, #007acc); }
.output-line.step { color: #4ec9b0; font-weight: 600; }
</style>
