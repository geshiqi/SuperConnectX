/**
 * 命令面板输出行的诊断级着色分类。
 *
 * 面板输出默认只按流分色(stderr 红/stdout 无色),而 gcc 系工具的 warning 输出到
 * stdout,仅按流分色时告警无色。此模块按行内容识别编译错误/告警关键词,补足该场景;
 * 匹配风格对齐 ninja/编译器终端行为(整行着色),不解析 ANSI(子进程经管道输出,
 * 工具侧已自动关闭颜色,文本本就是纯文本)。
 */

// gcc/armcc/cmake/ninja/make/链接器 的常见错误形态
const ERROR_RE =
  /(fatal error:|error:|error C\d+|CMake Error|FAILED:|undefined reference|multiple definition|\*\*\*.*Error|\bError \d)/i

// gcc/armcc/cmake/MSVC 的常见告警形态
const WARNING_RE = /(warning:|warning C\d+|CMake Warning)/i

/** 返回该行的诊断着色类;非诊断行返回空串(保持原按流着色) */
export function classifyDiagnosticLine(text: string): 'diag-error' | 'diag-warning' | '' {
  if (ERROR_RE.test(text)) return 'diag-error'
  if (WARNING_RE.test(text)) return 'diag-warning'
  return ''
}
