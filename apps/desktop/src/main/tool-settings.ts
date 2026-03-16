import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { is } from '@electron-toolkit/utils'

export type ToolScope = 'browser' | 'brain'

export type ToolCatalogEntry = {
  name: string
  label: string
  description: string
  scope: ToolScope
}

export type ToolCatalogSection = {
  id: string
  title: string
  description: string
  tools: ToolCatalogEntry[]
}

export type ToolStateMap = Record<string, boolean>

type SharedToolSettingsPayload = {
  version: number
  updatedAt: string
  tools: ToolStateMap
}

const BROWSER_CORE_TOOLS: ToolCatalogEntry[] = [
  { name: 'browser_navigate', label: 'Navigate', description: 'Open a URL directly in the current tab.', scope: 'browser' },
  { name: 'browser_navigate_back', label: 'Back', description: 'Go back to the previous page.', scope: 'browser' },
  { name: 'browser_close', label: 'Close Page', description: 'Close the current browser page.', scope: 'browser' },
  { name: 'browser_snapshot', label: 'Snapshot', description: 'Capture the structured page snapshot used for ref-based actions.', scope: 'browser' },
  { name: 'browser_click', label: 'Click', description: 'Click a page element using an exact snapshot ref.', scope: 'browser' },
  { name: 'browser_hover', label: 'Hover', description: 'Hover over an element on the page.', scope: 'browser' },
  { name: 'browser_type', label: 'Type', description: 'Type or submit text into an element selected by ref.', scope: 'browser' },
  { name: 'browser_fill_form', label: 'Fill Form', description: 'Fill multiple form fields in one call.', scope: 'browser' },
  { name: 'browser_select_option', label: 'Select Option', description: 'Choose one or more values in a dropdown.', scope: 'browser' },
  { name: 'browser_file_upload', label: 'File Upload', description: 'Upload local files into the current page.', scope: 'browser' },
  { name: 'browser_drag', label: 'Drag and Drop', description: 'Drag from one referenced element to another.', scope: 'browser' },
  { name: 'browser_wait_for', label: 'Wait', description: 'Wait for time, text appearance, or text disappearance.', scope: 'browser' },
  { name: 'browser_evaluate', label: 'Evaluate JS', description: 'Run JavaScript in the page context.', scope: 'browser' },
  { name: 'browser_take_screenshot', label: 'Screenshot', description: 'Take a viewport, full-page, or element screenshot.', scope: 'browser' },
  { name: 'browser_console_messages', label: 'Console Messages', description: 'Read console output captured from the page.', scope: 'browser' },
  { name: 'browser_network_requests', label: 'Network Requests', description: 'Inspect recent network requests from the page.', scope: 'browser' },
  { name: 'browser_handle_dialog', label: 'Handle Dialog', description: 'Accept or dismiss browser dialogs.', scope: 'browser' },
  { name: 'browser_install', label: 'Install Browser', description: 'Install the configured browser runtime.', scope: 'browser' },
  { name: 'browser_resize', label: 'Resize Window', description: 'Resize the browser viewport.', scope: 'browser' },
  { name: 'browser_press_key', label: 'Press Key', description: 'Send a keyboard key press.', scope: 'browser' },
  { name: 'browser_tabs', label: 'Tabs', description: 'List, create, close, or switch tabs.', scope: 'browser' },
  { name: 'browser_render_markdown', label: 'Render Markdown', description: 'Open rendered Markdown as a browser page.', scope: 'browser' }
]

const BROWSER_VISUAL_TOOLS: ToolCatalogEntry[] = [
  { name: 'browser_inspect_visual', label: 'Inspect Visual', description: 'Ask the vision model to find visual candidates in the viewport.', scope: 'browser' },
  { name: 'browser_ask_visual', label: 'Ask Visual', description: 'Ask the vision model questions about screenshots or referenced images.', scope: 'browser' },
  { name: 'browser_click_point', label: 'Click Point', description: 'Click a normalized point from a visual inspection result.', scope: 'browser' },
  { name: 'browser_type_point', label: 'Type Point', description: 'Focus a normalized point and type or submit text.', scope: 'browser' },
  { name: 'browser_mouse_click_xy', label: 'Mouse Click XY', description: 'Click an absolute mouse position.', scope: 'browser' },
  { name: 'browser_mouse_move_xy', label: 'Mouse Move XY', description: 'Move the mouse to an absolute position.', scope: 'browser' },
  { name: 'browser_mouse_drag_xy', label: 'Mouse Drag XY', description: 'Drag the mouse between absolute positions.', scope: 'browser' }
]

const BROWSER_OUTPUT_TOOLS: ToolCatalogEntry[] = [
  { name: 'browser_pdf_save', label: 'Save PDF', description: 'Save the current page as a PDF file.', scope: 'browser' },
  { name: 'browser_generate_locator', label: 'Generate Locator', description: 'Generate a locator from a referenced element.', scope: 'browser' },
  { name: 'browser_verify_element_visible', label: 'Verify Element Visible', description: 'Assert that an element is visible.', scope: 'browser' },
  { name: 'browser_verify_text_visible', label: 'Verify Text Visible', description: 'Assert that text is visible on the page.', scope: 'browser' },
  { name: 'browser_verify_value', label: 'Verify Value', description: 'Assert the value of a referenced element.', scope: 'browser' },
  { name: 'browser_verify_list_visible', label: 'Verify List Visible', description: 'Assert the contents of a referenced list.', scope: 'browser' },
  { name: 'browser_start_tracing', label: 'Start Tracing', description: 'Start Playwright tracing for the active session.', scope: 'browser' },
  { name: 'browser_stop_tracing', label: 'Stop Tracing', description: 'Stop tracing and finalize the trace output.', scope: 'browser' }
]

const BRAIN_PLANNING_TOOLS: ToolCatalogEntry[] = [
  { name: 'manage_todos', label: 'Manage Todos', description: 'Create and update a simple task list for execution.', scope: 'brain' },
  { name: 'manage_complex_todos', label: 'Manage Complex Todos', description: 'Create grouped plans for advanced coordination.', scope: 'brain' },
  { name: 'dispatch_sub_agent', label: 'Dispatch Sub-Agent', description: 'Run delegated sub-agents in parallel.', scope: 'brain' },
  { name: 'manage_skills', label: 'Manage Skills', description: 'Search, inspect, install, and list optional skills.', scope: 'brain' }
]

const BRAIN_EXECUTION_TOOLS: ToolCatalogEntry[] = [
  { name: 'exec_command', label: 'Exec Command', description: 'Start a shell command or process in the workspace.', scope: 'brain' },
  { name: 'write_stdin', label: 'Write Stdin', description: 'Send input, poll output, or signal a running exec session.', scope: 'brain' },
  { name: 'file_edit', label: 'File Edit', description: 'Apply exact text replacements to create, edit, or delete files.', scope: 'brain' }
]

const TOOL_CATALOG_SECTIONS: ToolCatalogSection[] = [
  {
    id: 'browser-core',
    title: 'Browser Core',
    description: 'Navigation, interaction, inspection, and page utilities used for most browser tasks.',
    tools: BROWSER_CORE_TOOLS
  },
  {
    id: 'browser-visual',
    title: 'Browser Visual AI',
    description: 'Vision-model-assisted tools for ambiguous, spatial, or state-sensitive interfaces.',
    tools: BROWSER_VISUAL_TOOLS
  },
  {
    id: 'browser-output',
    title: 'Browser Output & Debug',
    description: 'PDF export, verification helpers, and trace/debugging utilities.',
    tools: BROWSER_OUTPUT_TOOLS
  },
  {
    id: 'brain-planning',
    title: 'Brain Planning & Delegation',
    description: 'Planning, skill discovery, and multi-agent coordination tools exposed by the Brain.',
    tools: BRAIN_PLANNING_TOOLS
  },
  {
    id: 'brain-execution',
    title: 'Brain Local Execution',
    description: 'Workspace execution and file-editing tools exposed by the Brain.',
    tools: BRAIN_EXECUTION_TOOLS
  }
]

const SETTINGS_FILENAME = 'tool-settings.json'

const ALL_TOOLS = TOOL_CATALOG_SECTIONS.flatMap((section) => section.tools)

const DEFAULT_TOOL_STATES: ToolStateMap = Object.freeze(
  Object.fromEntries(ALL_TOOLS.map((tool) => [tool.name, true]))
)

function ensureDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
}

function findWorkspaceRoot(startDir: string): string {
  let current = startDir
  while (true) {
    const hasWorkspace = fs.existsSync(path.join(current, 'pnpm-workspace.yaml'))
    const hasTurbo = fs.existsSync(path.join(current, 'turbo.json'))
    if (hasWorkspace || hasTurbo) {
      return current
    }
    const parent = path.dirname(current)
    if (parent === current) {
      return startDir
    }
    current = parent
  }
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'y', 'on'].includes(lowered)) return true
    if (['false', '0', 'no', 'n', 'off'].includes(lowered)) return false
  }
  return fallback
}

export function getToolCatalogSections(): ToolCatalogSection[] {
  return TOOL_CATALOG_SECTIONS.map((section) => ({
    ...section,
    tools: section.tools.map((tool) => ({ ...tool }))
  }))
}

export function getDefaultToolStates(): ToolStateMap {
  return { ...DEFAULT_TOOL_STATES }
}

export function normalizeToolStates(value: unknown): ToolStateMap {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const next = getDefaultToolStates()
  for (const tool of ALL_TOOLS) {
    if (Object.prototype.hasOwnProperty.call(record, tool.name)) {
      next[tool.name] = normalizeBoolean(record[tool.name], next[tool.name])
    }
  }
  return next
}

export function mergeToolStates(current: ToolStateMap, patch: unknown): ToolStateMap {
  const base = normalizeToolStates(current)
  if (!patch || typeof patch !== 'object') {
    return base
  }
  const record = patch as Record<string, unknown>
  for (const tool of ALL_TOOLS) {
    if (Object.prototype.hasOwnProperty.call(record, tool.name)) {
      base[tool.name] = normalizeBoolean(record[tool.name], base[tool.name])
    }
  }
  return base
}

export function resolveSharedToolSettingsPath(): string {
  const fromEnv = process.env.ALPHOMI_TOOL_SETTINGS_PATH?.trim()
  if (fromEnv) {
    return path.resolve(fromEnv)
  }

  if (is.dev) {
    const workspaceRoot = findWorkspaceRoot(process.cwd())
    return path.join(workspaceRoot, 'temp', SETTINGS_FILENAME)
  }

  return path.join(app.getPath('userData'), SETTINGS_FILENAME)
}

export function syncSharedToolSettings(toolStates: ToolStateMap): string {
  const filePath = resolveSharedToolSettingsPath()
  ensureDir(filePath)
  const payload: SharedToolSettingsPayload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    tools: normalizeToolStates(toolStates)
  }
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8')
  return filePath
}
