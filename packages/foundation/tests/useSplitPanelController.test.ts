/**
 * useSplitPanelController - 分屏面板 Tab 编排测试（foundation/workbench）
 * 测试：面板归属查询 / 关闭 tab 后的面板激活回退 / 空面板合并
 */
import { describe, it, expect } from 'vitest'
import { nextTick, ref } from 'vue'
import { useSplitPanelController } from '../src/workbench/useSplitPanelController'
import { useSplitWorkspace } from '../src/workbench/useSplitWorkspace'
import type { SplitState } from '../src/workbench/useSplitWorkspace'

interface TestTab {
  id: string
}

interface SetupResult {
  tabsRef: ReturnType<typeof ref<TestTab[]>>
  activeTabId: ReturnType<typeof ref<string>>
  splitState: SplitState
  removeTab: (tabId: string) => void
  controller: ReturnType<typeof useSplitPanelController<TestTab>>
}

/**
 * 构建一个最小分屏编排环境：全局 tabs + 全局 activeTabId + 分屏布局。
 * removeTab 模拟宿主（useWorkbenchTabs.removeTab）行为：
 * 从列表移除，若移除的是全局激活 tab 则回退到最后一个。
 */
function setup(tabs: TestTab[]): SetupResult {
  const tabsRef = ref<TestTab[]>(tabs)
  const activeTabId = ref('')
  const workspace = useSplitWorkspace()
  const splitState: SplitState = workspace.splitState

  const removeTab = (tabId: string): void => {
    const index = tabsRef.value.findIndex((t) => t.id === tabId)
    if (index !== -1) tabsRef.value.splice(index, 1)
    if (activeTabId.value === tabId && tabsRef.value.length > 0) {
      activeTabId.value = tabsRef.value[tabsRef.value.length - 1].id
    }
  }

  const controller = useSplitPanelController<TestTab>({
    tabs: tabsRef,
    getTabId: (tab) => tab.id,
    activeTabId,
    splitState,
    splitPanel: workspace.splitPanel,
    showTabMenu: ref(false),
    rightClickedTab: ref(null),
    hideTabMenu: () => {},
    closeTab: (tabId) => removeTab(tabId)
  })

  return { tabsRef, activeTabId, splitState, removeTab, controller }
}

describe('useSplitPanelController - 关闭 tab 后的面板激活回退', () => {
  it('复现：panel-0 关闭激活 tab 应回退到本面板显示列表中的 tab，而非备份列表第一个', async () => {
    // COM72 先打开（panel-0 备份列表第一个），随后分屏到右侧面板；
    // 左侧面板显示 COM21 / COM22，激活 COM22 后关闭它。
    const { activeTabId, splitState, removeTab, controller } = setup([
      { id: 'com-COM72' },
      { id: 'com-COM21' },
      { id: 'com-COM22' }
    ])
    activeTabId.value = 'com-COM72'
    await nextTick()
    // panel-0 备份补齐
    expect(splitState.panels[0].tabIds).toEqual(['com-COM72', 'com-COM21', 'com-COM22'])

    // 将 COM72 分屏到右侧面板
    controller.performSplitWithTab('com-COM72', 'panel-0')
    expect(splitState.panels).toHaveLength(2)
    expect(splitState.panels[1].tabIds).toEqual(['com-COM72'])

    // 用户先在左侧面板切换到 COM22，随后查看右侧面板的 COM72
    // （全局激活 = com-COM72），再回到左侧面板直接点击 COM22 的关闭按钮
    splitState.panels[0].activeTabId = 'com-COM22'
    activeTabId.value = 'com-COM22'
    await nextTick()
    activeTabId.value = 'com-COM72'
    await nextTick()

    removeTab('com-COM22')
    await nextTick()

    // 左侧面板仍显示 COM21：激活 tab 必须是 COM21，不能落到右侧面板的 COM72
    expect(splitState.panels[0].activeTabId).toBe('com-COM21')
  })

  it('全局激活回退到其它面板 tab 时，panel-0 的激活也应回退到本面板 tab', async () => {
    // 打开顺序 COM21 / COM22 / COM72：关闭 COM22 后全局回退落到 COM72（右侧面板）
    const { tabsRef, activeTabId, splitState, removeTab, controller } = setup([
      { id: 'com-COM21' },
      { id: 'com-COM22' },
      { id: 'com-COM72' }
    ])
    activeTabId.value = 'com-COM22'
    await nextTick()
    controller.performSplitWithTab('com-COM72', 'panel-0')
    splitState.panels[0].activeTabId = 'com-COM22'
    activeTabId.value = 'com-COM22'
    await nextTick()

    removeTab('com-COM22')
    await nextTick()

    expect(tabsRef.value.map((t) => t.id)).toEqual(['com-COM21', 'com-COM72'])
    expect(splitState.panels[0].activeTabId).toBe('com-COM21')
    expect(splitState.panels[1].activeTabId).toBe('com-COM72')
  })

  it('非 panel-0 面板关闭激活 tab 应回退到本面板第一个 tab', async () => {
    const { activeTabId, splitState, removeTab, controller } = setup([
      { id: 'com-COM21' },
      { id: 'com-COM72' },
      { id: 'com-COM73' }
    ])
    activeTabId.value = 'com-COM21'
    await nextTick()
    controller.performSplitWithTab('com-COM72', 'panel-0')
    // 右侧面板拥有 COM72 / COM73，激活 COM73 后关闭
    splitState.panels[1].tabIds = ['com-COM72', 'com-COM73']
    splitState.panels[1].activeTabId = 'com-COM73'
    activeTabId.value = 'com-COM73'
    await nextTick()

    removeTab('com-COM73')
    await nextTick()

    expect(splitState.panels[1].activeTabId).toBe('com-COM72')
  })

  it('面板显示列表为空时应触发空面板合并', async () => {
    const { activeTabId, splitState, removeTab, controller } = setup([
      { id: 'com-COM21' },
      { id: 'com-COM72' }
    ])
    activeTabId.value = 'com-COM21'
    await nextTick()
    controller.performSplitWithTab('com-COM72', 'panel-0')
    expect(splitState.panels).toHaveLength(2)

    removeTab('com-COM72')
    await nextTick()

    expect(splitState.panels).toHaveLength(1)
  })
})
