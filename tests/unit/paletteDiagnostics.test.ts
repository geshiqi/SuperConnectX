/**
 * 命令面板诊断着色分类单测:覆盖 gcc/armcc/cmake/ninja/make 常见形态与防误报场景
 */
import { describe, it, expect } from 'vitest'
import { classifyDiagnosticLine } from '@/renderer/src/palette/diagnostics'

describe('classifyDiagnosticLine', () => {
  it('gcc 错误/告警', () => {
    expect(classifyDiagnosticLine('main.c:42:5: error: use of undeclared identifier \'foo\'')).toBe('diag-error')
    expect(classifyDiagnosticLine('main.c:10:3: fatal error: header.h: No such file or directory')).toBe('diag-error')
    expect(classifyDiagnosticLine('main.c:42:5: warning: unused variable \'x\' [-Wunused-variable]')).toBe('diag-warning')
  })

  it('armcc/armclang 形态', () => {
    expect(classifyDiagnosticLine('main.c:55: Warning: #223-D: function declared but never referenced')).toBe('diag-warning')
    expect(classifyDiagnosticLine('main.c:55: Error: #268-D: declaration may not appear after executable statement')).toBe('diag-error')
  })

  it('cmake/ninja/make 形态', () => {
    expect(classifyDiagnosticLine('CMake Error at CMakeLists.txt:12 (target_link_libraries):')).toBe('diag-error')
    expect(classifyDiagnosticLine('CMake Warning at cmake/utils.cmake:5 ():')).toBe('diag-warning')
    expect(classifyDiagnosticLine('FAILED: CMakeFiles/app.dir/src/main.c.obj')).toBe('diag-error')
    expect(classifyDiagnosticLine('make: *** [Makefile:66: build/app.hex] Error 1')).toBe('diag-error')
  })

  it('链接器错误', () => {
    expect(classifyDiagnosticLine('undefined reference to `hal_uart_init\'')).toBe('diag-error')
    expect(classifyDiagnosticLine('multiple definition of `system_config\'')).toBe('diag-error')
  })

  it('正常构建输出不误报', () => {
    expect(classifyDiagnosticLine('[5/66] Building C object CMakeFiles/app.dir/src/main.c.obj')).toBe('')
    expect(classifyDiagnosticLine('-- Configuring done (0.8s)')).toBe('')
    // 编译摘要行不整行标红(数字统计,非诊断本体)
    expect(classifyDiagnosticLine('0 errors, 2 warnings')).toBe('')
    expect(classifyDiagnosticLine('Build finished successfully')).toBe('')
  })

  it('空行/未定义安全', () => {
    expect(classifyDiagnosticLine('')).toBe('')
  })
})
