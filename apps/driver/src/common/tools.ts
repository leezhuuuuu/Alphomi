import { z } from 'zod';

// 通用的元素定位参数
const ElementRefSchema = z.object({
  element: z.string().describe('Human-readable element description used to obtain permission to interact with element'),
  ref: z.string().describe('Exact target element reference from the page snapshot'),
});

export const ToolCategories = {
  CORE: 'core',
  VISION: 'vision',
  PDF: 'pdf',
  TESTING: 'testing',
  TRACING: 'tracing',
};

/**
 * 浏览器工具集
 */
export const TOOLS = {
  // --- 核心导航 (Core) ---
  
  browser_navigate: {
    name: 'browser_navigate',
    description: 'Navigate to a URL',
    inputSchema: z.object({
      // 移除 .url() 校验，改为允许普通字符串，靠后端处理
      url: z.string().describe('The URL to navigate to (e.g., https://google.com)'),
    }),
  },

  browser_navigate_back: {
    name: 'browser_navigate_back',
    description: 'Go back to previous page',
    inputSchema: z.object({}),
  },

  browser_close: {
    name: 'browser_close',
    description: 'Close page',
    inputSchema: z.object({}),
  },

  browser_snapshot: {
    name: 'browser_snapshot',
    description: 'Capture accessibility snapshot of current page, this is better than screenshot',
    inputSchema: z.object({
      full: z.boolean().optional().describe('Set to true to see full lists without compression.'),
      forceFullSnapshot: z.boolean().optional().describe('Set to true to force a complete full snapshot (no diff output). Default: false.'),
    }),
  },

  // --- 核心交互 (Core) ---

  browser_click: {
    name: 'browser_click',
    description: 'Perform click on a web page using an exact target element ref from the page snapshot',
    inputSchema: ElementRefSchema.extend({
      doubleClick: z.boolean().optional().describe('Whether to perform a double click instead of a single click'),
      button: z.enum(['left', 'right', 'middle']).optional().describe('Button to click, defaults to left'),
      modifiers: z.array(z.enum(['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift'])).optional().describe('Modifier keys to press'),
    }),
  },

  browser_hover: {
    name: 'browser_hover',
    description: 'Hover over element on page',
    inputSchema: ElementRefSchema,
  },

  browser_type: {
    name: 'browser_type',
    description: 'Type text into an editable element identified by an exact page snapshot ref, or press Enter. Prefer inputKind="code" for code editors and terminal command input/execution.',
    inputSchema: ElementRefSchema.extend({
      text: z.string().optional().describe('Text to input. Optional if you only want to submit.'),
      submit: z.boolean().optional().describe('Whether to submit entered text (press Enter after)'),
      inputKind: z
        .enum(['normal', 'code'])
        .optional()
        .describe('Input strategy hint. Strongly recommended: use "code" for code editing and terminal command input/execution (e.g., Colab code cells/terminal, Monaco, CodeMirror). Use "normal" for regular text fields. Default: "normal".'),
    }),
  },

  browser_fill_form: {
    name: 'browser_fill_form',
    description: 'Fill multiple form fields',
    inputSchema: z.object({
      fields: z.array(z.object({
        ref: z.string().describe('Exact target field reference from page snapshot'),
        value: z.string().describe('Value to fill in field. For checkbox, use "true" or "false".'),
      })).describe('Fields to fill in'),
    }),
  },

  browser_select_option: {
    name: 'browser_select_option',
    description: 'Select an option in a dropdown',
    inputSchema: ElementRefSchema.extend({
      values: z.array(z.string()).describe('Array of values to select in dropdown'),
    }),
  },

  browser_file_upload: {
    name: 'browser_file_upload',
    description: 'Upload one or multiple files',
    inputSchema: z.object({
      paths: z.array(z.string()).optional().describe('The absolute paths to files to upload. If omitted, file chooser is cancelled.'),
    }),
  },

  browser_drag: {
    name: 'browser_drag',
    description: 'Perform drag and drop between two elements',
    inputSchema: z.object({
      startElement: z.string().describe('Human-readable source element description'),
      startRef: z.string().describe('Exact source element reference'),
      endElement: z.string().describe('Human-readable target element description'),
      endRef: z.string().describe('Exact target element reference'),
    }),
  },

  // --- 系统功能 (Core) ---

  browser_wait_for: {
    name: 'browser_wait_for',
    description: 'Wait for text to appear or disappear or a specified time to pass',
    inputSchema: z.object({
      time: z.number().optional().describe('The time to wait in seconds'),
      text: z.string().optional().describe('The text to wait for'),
      textGone: z.string().optional().describe('The text to wait for to disappear'),
    }),
  },

  browser_evaluate: {
    name: 'browser_evaluate',
    description: 'Evaluate JavaScript expression on page or element',
    inputSchema: z.object({
      function: z.string().describe('JavaScript code to evaluate. E.g. "() => window.location.href"'),
      ref: z.string().optional().describe('Optional element reference to pass as argument to function'),
    }),
  },

  browser_take_screenshot: {
    name: 'browser_take_screenshot',
    description: 'Take a screenshot of current page',
    inputSchema: z.object({
      type: z.enum(['png', 'jpeg']).optional().default('png'),
      fullPage: z.boolean().optional(),
      ref: z.string().optional().describe('Element reference for element screenshot'),
    }),
  },

  browser_console_messages: {
    name: 'browser_console_messages',
    description: 'Returns all console messages',
    inputSchema: z.object({
      onlyErrors: z.boolean().optional().describe('Only return error messages'),
    }),
  },

  browser_network_requests: {
    name: 'browser_network_requests',
    description: 'Returns all network requests since loading page',
    inputSchema: z.object({}),
  },

  browser_handle_dialog: {
    name: 'browser_handle_dialog',
    description: 'Handle a dialog',
    inputSchema: z.object({
      accept: z.boolean().describe('Whether to accept dialog'),
      promptText: z.string().optional().describe('The text of prompt in case of a prompt dialog'),
    }),
  },

  browser_install: {
    name: 'browser_install',
    description: 'Install browser specified in config',
    inputSchema: z.object({}),
  },

  browser_resize: {
    name: 'browser_resize',
    description: 'Resize browser window',
    inputSchema: z.object({
      width: z.number(),
      height: z.number(),
    }),
  },

  browser_press_key: {
    name: 'browser_press_key',
    description: 'Press a key on keyboard',
    inputSchema: z.object({
      key: z.string().describe('Name of key to press (e.g., "Enter", "Tab", "a")'),
    }),
  },

  // --- 标签页管理 (Tabs) ---

  browser_tabs: {
    name: 'browser_tabs',
    description: 'List, create, close, or select a browser tab',
    inputSchema: z.object({
      action: z.enum(['list', 'new', 'close', 'select']).describe('Operation to perform'),
      index: z.number().optional().describe('Tab index for close/select actions'),
      url: z.string().optional().describe('URL to open when creating a new tab'),
    }),
  },

  browser_render_markdown: {
    name: 'browser_render_markdown',
    description: 'Render Markdown content in a new browser tab as a standalone page',
    inputSchema: z.object({
      markdown: z.string().describe('Markdown content to render'),
      title: z.string().optional().describe('Optional document title'),
      theme: z.enum(['light', 'dark', 'system']).optional().describe('Theme mode to apply'),
    }),
  },

  // --- 视觉操作 (Vision) - 可选 ---

  browser_inspect_visual: {
    name: 'browser_inspect_visual',
    description: 'Inspect the current viewport screenshot with a VLM and return all matching visual candidates using normalized [0,1000] coordinates, optionally including a short visual state description',
    category: ToolCategories.VISION,
    inputSchema: z.object({
      targetName: z.string().describe('The target UI element name to find in the current viewport screenshot'),
      includeState: z
        .boolean()
        .describe('Whether the VLM should include a short description of the component\'s visually observable state. Always pass true or false.'),
      contextHint: z.string().optional().describe('Optional extra guidance to disambiguate visually similar targets'),
    }),
  },

  browser_ask_visual: {
    name: 'browser_ask_visual',
    description: 'Ask a VLM a question about the current viewport/full-page screenshot and/or referenced images',
    category: ToolCategories.VISION,
    inputSchema: z.object({
      question: z.string().describe('The visual question to ask about the provided screenshots'),
      answerMode: z
        .enum(['text', 'json'])
        .describe('Whether the answer should be returned as plain text or structured JSON'),
      captureScope: z
        .enum(['viewport', 'full_page'])
        .optional()
        .describe('Optional current-page capture scope to include. Provide captureScope, imageRefs, or both.'),
      imageRefs: z
        .array(z.string())
        .optional()
        .describe('Optional image references to include alongside the current capture.'),
      contextHint: z.string().optional().describe('Optional extra guidance about which region or detail to focus on'),
    }),
  },

  browser_click_point: {
    name: 'browser_click_point',
    description: 'Click a normalized point (0-1000) within the current viewport using a previously created visual inspection',
    category: ToolCategories.VISION,
    inputSchema: z.object({
      inspectionId: z.string().describe('Visual inspection identifier returned by browser_inspect_visual'),
      x: z.number().int().min(0).max(1000).describe('Normalized X coordinate in the current viewport'),
      y: z.number().int().min(0).max(1000).describe('Normalized Y coordinate in the current viewport'),
    }),
  },

  browser_type_point: {
    name: 'browser_type_point',
    description: 'Focus a normalized point (0-1000) within the current viewport using a visual inspection, then type text or submit via keyboard',
    category: ToolCategories.VISION,
    inputSchema: z.object({
      inspectionId: z.string().describe('Visual inspection identifier returned by browser_inspect_visual'),
      x: z.number().int().min(0).max(1000).describe('Normalized X coordinate in the current viewport'),
      y: z.number().int().min(0).max(1000).describe('Normalized Y coordinate in the current viewport'),
      text: z.string().optional().describe('Text to input after focusing the point. Optional if you only want to submit.'),
      submit: z.boolean().optional().describe('Whether to submit entered text (press Enter after)'),
      inputKind: z
        .enum(['normal', 'code'])
        .optional()
        .describe('Input strategy hint. Use "code" for code editors and terminal command areas. Use "normal" for regular text fields.'),
    }),
  },
  
  browser_mouse_click_xy: {
    name: 'browser_mouse_click_xy',
    description: 'Click left mouse button at a given position',
    category: ToolCategories.VISION,
    inputSchema: z.object({
      x: z.number(),
      y: z.number(),
    }),
  },
  
  browser_mouse_move_xy: {
    name: 'browser_mouse_move_xy',
    description: 'Move mouse to a given position',
    category: ToolCategories.VISION,
    inputSchema: z.object({
      x: z.number(),
      y: z.number(),
    }),
  },

  browser_mouse_drag_xy: {
    name: 'browser_mouse_drag_xy',
    description: 'Drag left mouse button to a given position',
    category: ToolCategories.VISION,
    inputSchema: z.object({
      startX: z.number(),
      startY: z.number(),
      endX: z.number(),
      endY: z.number(),
    }),
  },

  // --- PDF (Pdf) ---

  browser_pdf_save: {
    name: 'browser_pdf_save',
    description: 'Save page as PDF',
    category: ToolCategories.PDF,
    inputSchema: z.object({
      filename: z.string().optional(),
    }),
  },

  // --- 测试与断言 (Testing) - 可选但推荐支持 ---

  browser_generate_locator: {
    name: 'browser_generate_locator',
    description: 'Create locator for element',
    category: ToolCategories.TESTING,
    inputSchema: ElementRefSchema,
  },

  browser_verify_element_visible: {
    name: 'browser_verify_element_visible',
    description: 'Verify element is visible on page',
    category: ToolCategories.TESTING,
    inputSchema: z.object({
      role: z.string().optional(),
      name: z.string().optional(),
    }),
  },

  browser_verify_text_visible: {
    name: 'browser_verify_text_visible',
    description: 'Verify text is visible on page',
    category: ToolCategories.TESTING,
    inputSchema: z.object({
      text: z.string(),
    }),
  },

  browser_verify_value: {
    name: 'browser_verify_value',
    description: 'Verify element value',
    category: ToolCategories.TESTING,
    inputSchema: ElementRefSchema.extend({
      value: z.string(),
    }),
  },

  browser_verify_list_visible: {
    name: 'browser_verify_list_visible',
    description: 'Verify list is visible on page',
    category: ToolCategories.TESTING,
    inputSchema: z.object({
      ref: z.string(),
      items: z.array(z.string()),
    }),
  },

  // --- 追踪 (Tracing) ---

  browser_start_tracing: {
    name: 'browser_start_tracing',
    description: 'Start trace recording',
    category: ToolCategories.TRACING,
    inputSchema: z.object({}),
  },

  browser_stop_tracing: {
    name: 'browser_stop_tracing',
    description: 'Stop trace recording',
    category: ToolCategories.TRACING,
    inputSchema: z.object({}),
  },

} as const;

export type ToolName = keyof typeof TOOLS;
