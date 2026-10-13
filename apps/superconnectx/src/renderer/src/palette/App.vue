<template>
  <div class="palette">
    <!-- 标题栏:拖拽区 + 关闭 -->
    <div class="palette-titlebar">
      <div class="title-text">{{ t('palette.title') }}</div>
      <button class="close-btn" :title="t('palette.close')" @click="closeWindow">
        <el-icon :size="14"><Close /></el-icon>
      </button>
    </div>

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
      <el-button type="primary" size="default" @click="openEditor(null)">
        <el-icon style="margin-right: 4px"><Plus /></el-icon>{{ t('palette.newTask') }}
      </el-button>
    </div>

    <!-- 任务列表 -->
    <div class="task-list" ref="taskListRef">
      <div v-if="filteredTasks.length === 0" class="empty-hint">{{ t('palette.noTasks') }}</div>
      <div
        v-for="(task, i) in filteredTasks"
        :key="task.id"
        class="task-item"
        :class="{ active: i === selectedIndex }"
        @mouseenter="selectedIndex = i"
        @click="runTask(task)"
      >
        <div class="task-main">
          <span class="task-name">{{ task.name }}</span>
          <el-tag v-if="task.group" size="small" type="info">{{ task.group }}</el-tag>
          <span class="task-meta">{{ task.steps.length }} {{ t('palette.stepsUnit') }}<template v-if="(task.repeat || 1) > 1"> × {{ task.repeat }}</template></span>
        </div>
        <div class="task-actions" @click.stop>
          <el-button size="small" text type="primary" :disabled="isRunning" @click="runTask(task)">
            <el-icon><CaretRight /></el-icon>
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

    <!-- 任务编辑对话框 -->
    <TaskEditor v-model="editorVisible" :task="editingTask" @saved="onTaskSaved" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessageBox } from 'element-plus'
import type { UserTask, TaskRunEvent } from '../../../shared/tasks/UserTask'
import TaskEditor from './TaskEditor.vue'

const { t } = useI18n()

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

const runTask = async (task: UserTask): Promise<void> => {
  if (isRunning.value) return
  const result = await window.taskApi.run(task.id)
  if (!result.success && result.message) {
    appendOutput(result.message, 'stderr')
  }
}

const runSelected = (): void => {
  const task = filteredTasks.value[selectedIndex.value]
  if (task) runTask(task)
}

const moveSelection = (delta: number): void => {
  const total = filteredTasks.value.length
  if (total === 0) return
  selectedIndex.value = (selectedIndex.value + delta + total) % total
}

const stopRun = async (): Promise<void> => {
  await window.taskApi.stop()
}

const clearOutput = (): void => {
  outputLines.value = []
  lastRunStatus.value = null
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

const openEditor = (task: UserTask | null): void => {
  editingTask.value = task
  editorVisible.value = true
}

const onTaskSaved = (updated: UserTask[]): void => {
  tasks.value = updated
}

const closeWindow = (): void => {
  window.close()
}

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

watch(filteredTasks, () => {
  if (selectedIndex.value >= filteredTasks.value.length) selectedIndex.value = 0
})

onMounted(async () => {
  removeListener = window.taskApi.onTaskEvent(handleEvent)
  await loadTasks()
  // 恢复上次运行状态显示(应用重启后面板是独立会话,不恢复历史输出)
  isRunning.value = await window.taskApi.isRunning()
  searchInputRef.value?.focus?.()
})

onUnmounted(() => {
  removeListener?.()
})
</script>

<style scoped>
.palette {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--container-bg, #1e1e1e);
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
  background: var(--statusbar-bg, #2d2d30);
  flex-shrink: 0;
}

.title-text {
  font-weight: 600;
  font-size: 12px;
  color: var(--text-white, #ccc);
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
  background: var(--btn-close-hover, #e81123);
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
  color: var(--text-muted, #888);
  text-align: center;
  padding: 24px 0;
}

.task-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
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
  color: var(--text-muted, #888);
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
  background: var(--statusbar-bg, #2d2d30);
  border-top: 1px solid var(--border-color, #3c3c3c);
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
  background: var(--text-muted, #6a6a6a);
}

.output-splitter:hover::after {
  background: var(--focus-border-color, #409eff);
}

.output-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  background: var(--statusbar-bg, #2d2d30);
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
.output-line.info { color: #9cdcfe; }
.output-line.step { color: #4ec9b0; font-weight: 600; }
</style>
