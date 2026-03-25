import React, {
  startTransition,
  useState,
  useEffect,
  useRef,
  useCallback,
} from "react";
import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Terminal,
  Copy,
  RotateCw,
  Pencil,
  BrainCircuit,
  AlertTriangle,
  Shield,
  Check,
  CheckCircle,
  Ban,
  Square,
  Loader2,
  ListChecks,
  ChevronUp,
  PlayCircle,
  BookOpen,
  Plus,
  MessageSquare,
  Trash2,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { TeachingWorkspace } from "./TeachingWorkspace";
import { useTeachingModeState } from "./useTeachingModeState";
import { TeachingContextSnapshot } from "./teachingTypes";

const HEADER_HORIZONTAL_PADDING = 28;
const HEADER_CONTROL_GAP = 8;
const HEADER_SESSION_TRIGGER_MIN_WIDTH = 164;
const HEADER_ACTION_BUTTON_MIN_WIDTH = 36;

const measureControlWidth = (node: HTMLElement | null) => {
  if (!node) return 0;
  return Math.ceil(node.getBoundingClientRect().width);
};

const measureInlineControlsWidth = (
  nodes: Array<HTMLElement | null>,
  gap: number,
) => {
  const widths = nodes
    .map((node) => measureControlWidth(node))
    .filter((width) => width > 0);

  if (!widths.length) return 0;

  return (
    widths.reduce((sum, width) => sum + width, 0) +
    gap * Math.max(0, widths.length - 1)
  );
};

// 定义消息类型
interface Message {
  role: "user" | "assistant" | "system";
  id?: string;
  parentId?: string;
  workSummary?: {
    elapsedSec: number;
    isWorking: boolean;
    currentLabel: string;
    isOpen: boolean;
  };
  content?: string; // 正文
  thought?: string; // 思考过程 (后端已剥离 think 标签)
  thoughtStartedAt?: number;
  thoughtDurationSec?: number;
  isThinking?: boolean; // 是否正在接收思考流
  toolCalls?: ToolCall[]; // 如果这条消息包含工具调用
}

type ToolCall = {
  id: string;
  name: string;
  status: "running" | "done" | "error";
  input?: any;
  output?: any;
};

// 审批请求类型定义
interface ApprovalRequest {
  type: "approval_request";
  id: string;
  toolCallId: string;
  toolName: string;
  args: any;
  riskLevel: "SAFE" | "RISKY" | "DANGEROUS";
}

type ChatSessionItem = {
  id: string;
  title: string;
  titleSource?: "fallback" | "ai" | "user";
  mode?: ModeId | null;
  createdAt?: string;
  updatedAt?: string;
  messageCount?: number;
  lastMessagePreview?: string;
};

type PersistedHistoryMessage = {
  role: "user" | "assistant" | "tool";
  content?: string;
  client_message_id?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: string;
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
};

type PersistedWorkSummaries = Record<
  string,
  {
    elapsedSec?: number;
    label?: string;
    thought?: string;
    updatedAt?: string;
  }
>;

type PersistedWorkEvent = {
  eventId?: string;
  seq?: number;
  type?: string;
  payload?: any;
  createdAt?: string;
};

type PersistedWorkEvents = Record<string, PersistedWorkEvent[]>;

type WorkRenderBlock =
  | {
      kind: "thought";
      key: string;
      thought: string;
      durationSec: number;
    }
  | {
      kind: "tool";
      key: string;
      toolCall: ToolCall;
    }
  | {
      kind: "status";
      key: string;
      label: string;
      text?: string;
    };

// [新增] 任务数据结构
interface TaskItem {
  index: number;
  status: "pending" | "done" | "failed" | "skipped";
  text: string;
  group?: string;
  result?: string;
  isCurrent: boolean;
  isReady: boolean;
  isFailedMarker: boolean;
}

type SubAgentLog = {
  kind: "think" | "content" | "tool" | "error" | "status";
  text: string;
};

type SubAgentTaskState = {
  title: string;
  status: "running" | "done" | "error";
  logs: SubAgentLog[];
  buffers?: {
    content?: string;
    think?: string;
    pendingTool?: {
      name?: string;
      input?: string;
      output?: string;
    };
  };
};

type SubAgentRun = {
  startedAt: number;
  tasks: Record<string, SubAgentTaskState>;
};

// [新增] Markdown Todo 解析器
const parseMarkdownTodos = (md: string): TaskItem[] => {
  const lines = md.split("\n");
  const tasks: TaskItem[] = [];

  const lineRegex =
    /^(\d+)\.\s*\[([ x!\-\?])\]\s*(.*?)(?:\s*\(Group:\s*(.*?)\))?(?:\s*\(Result:\s*(.*)\))?(?:\s*<---\s*(READY|FAILED|CURRENT).*)?$/;
  const resultRegex = /^-\s*Result:\s*(.*)$/i;

  lines.forEach((line) => {
    const trimmed = line.trim();
    const match = trimmed.match(lineRegex);
    if (match) {
      const statusChar = match[2];
      let status: TaskItem["status"] = "pending";
      if (statusChar === "x") status = "done";
      if (statusChar === "-") status = "failed";
      if (statusChar === "!") status = "failed";
      if (statusChar === "?") status = "skipped";

      const marker = match[6] || "";
      tasks.push({
        index: parseInt(match[1]),
        status,
        text: match[3].trim(),
        group: match[4] ? match[4].trim() : undefined,
        result: match[5] ? match[5].trim() : undefined,
        isCurrent: marker === "CURRENT",
        isReady: marker === "READY",
        isFailedMarker: marker === "FAILED",
      });
      return;
    }

    const resultMatch = trimmed.match(resultRegex);
    if (resultMatch && tasks.length > 0) {
      const last = tasks[tasks.length - 1];
      last.result = resultMatch[1]?.trim() || last.result;
    }
  });

  return tasks;
};

const TaskBoard = ({ tasks }: { tasks: TaskItem[] }) => {
  const [isExpanded, setIsExpanded] = useState(true);

  const readyTasks = tasks.filter((t) => t.isReady);
  const currentTask =
    readyTasks[0] ||
    tasks.find((t) => t.isCurrent) ||
    tasks.find((t) => t.status === "pending") ||
    tasks[tasks.length - 1];

  const doneCount = tasks.filter(
    (t) => t.status === "done" || t.status === "skipped",
  ).length;
  const progress = Math.round((doneCount / tasks.length) * 100);
  const isAllDone = doneCount === tasks.length;
  const readyCount = readyTasks.length;

  const prevDoneCountRef = useRef(doneCount);
  const prevTasksLengthRef = useRef(tasks.length);

  useEffect(() => {
    if (tasks.length !== prevTasksLengthRef.current) {
      setIsExpanded(true);
    } else if (doneCount > prevDoneCountRef.current) {
      const timer = setTimeout(() => {
        setIsExpanded(false);
      }, 1500);
      return () => clearTimeout(timer);
    }

    prevDoneCountRef.current = doneCount;
    prevTasksLengthRef.current = tasks.length;
  }, [doneCount, tasks.length]);

  if (!tasks || tasks.length === 0) return null;

  return (
    <div
      className="mx-3.5 mt-2.5 mb-1.5 overflow-hidden rounded-[16px] border border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/92 backdrop-blur-xl transition-all duration-300"
      style={{ boxShadow: "var(--shadow-soft)" }}
    >
      <div
        className="flex cursor-pointer items-center justify-between gap-2.5 px-2.5 py-2.5 transition-colors hover:bg-black/[0.025] dark:hover:bg-white/[0.03]"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <div className="relative flex h-8 w-8 items-center justify-center rounded-[12px] bg-[var(--field-focus-ring)] text-[color:var(--theme-accent)]">
            {isAllDone ? (
              <CheckCircle
                size={16}
                className="animate-in zoom-in text-emerald-600 dark:text-emerald-400"
              />
            ) : (
              <div className="text-[10px] font-bold tracking-[0.02em]">
                {Math.round(progress)}%
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] uppercase tracking-[0.14em] text-[color:var(--text-tertiary)]">
              Mission Board
            </div>
            <div className="truncate text-[13px] font-semibold text-[color:var(--text-primary)]">
              {isAllDone
                ? "任务完成"
                : readyCount > 1
                  ? `并行推进 ${readyCount} 项任务`
                  : "正在推进当前任务"}
            </div>
            <div className="mt-0.5 text-[10px] text-[color:var(--text-secondary)]">
              {doneCount} / {tasks.length} completed
              {currentTask && !isAllDone ? ` · ${currentTask.text}` : ""}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {!isAllDone && readyCount > 1 ? (
            <div className="rounded-full border border-[color:var(--field-border-strong)] bg-[var(--field-focus-ring)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--theme-accent)]">
              {readyCount} ready
            </div>
          ) : null}
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-black/[0.05] text-[color:var(--text-secondary)] dark:bg-white/[0.05]">
            {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </div>
        </div>
      </div>

      <div className="h-px w-full bg-[color:var(--border-soft)]" />
      <div className="h-1 w-full bg-black/[0.04] dark:bg-white/[0.04]">
        <div
          className="h-full rounded-full bg-[var(--theme-accent)] transition-all duration-500 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>

      <div className="bg-[linear-gradient(180deg,transparent_0%,rgba(0,0,0,0.02)_100%)] dark:bg-[linear-gradient(180deg,transparent_0%,rgba(255,255,255,0.02)_100%)]">
        {!isExpanded && !isAllDone && currentTask && (
          <div className="flex items-start gap-2.5 px-2.5 py-2.5 animate-in slide-in-from-top-1 fade-in duration-300">
            <div className="relative mt-0.5 flex h-7 w-7 items-center justify-center rounded-full bg-[var(--field-focus-ring)] text-[color:var(--theme-accent)]">
              <div className="absolute inset-1 rounded-full border border-[color:var(--field-border-strong)] opacity-50" />
              <PlayCircle size={14} className="relative z-10" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-[color:var(--text-primary)]">
                {currentTask.text}
              </div>
              <div className="mt-0.5 text-[10px] text-[color:var(--text-secondary)]">
                {readyCount > 1
                  ? `可并行执行 ${readyCount} 项`
                  : `正在执行步骤 ${currentTask.index}`}
              </div>
            </div>
          </div>
        )}

        {isExpanded && (
          <div className="max-h-[190px] space-y-1 overflow-y-auto p-2 animate-in slide-in-from-top-2">
            {tasks.map((task) => {
              const isActive = task.index === currentTask?.index && !isAllDone;
              const isReady = task.isReady;
              const isFailed = task.status === "failed" || task.isFailedMarker;

              let itemClass =
                "border-transparent bg-transparent text-[color:var(--text-secondary)] hover:bg-black/[0.025] dark:hover:bg-white/[0.02]";
              if (task.status === "done") {
                itemClass =
                  "border-transparent bg-black/[0.03] dark:bg-white/[0.03] text-[color:var(--text-tertiary)]";
              } else if (isFailed) {
                itemClass =
                  "border border-red-200/80 bg-red-50/80 text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200";
              } else if (isReady) {
                itemClass =
                  "border border-[color:var(--field-border-strong)] bg-[var(--field-focus-ring)] text-[color:var(--text-primary)]";
              } else if (isActive) {
                itemClass =
                  "border border-[color:var(--border-soft)] bg-[var(--shell-surface-muted)] text-[color:var(--text-primary)]";
              }

              return (
                <div
                  key={task.index}
                  className={`rounded-[12px] border px-2.5 py-2 text-xs transition-all duration-300 ${itemClass}`}
                >
                  <div className="flex items-start gap-2">
                    <div className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full">
                      {task.status === "done" ? (
                        <CheckCircle
                          size={14}
                          className="text-emerald-600 dark:text-emerald-400"
                        />
                      ) : isFailed ? (
                        <AlertTriangle size={14} className="text-red-500" />
                      ) : isActive ? (
                        <PlayCircle
                          size={14}
                          className="text-[color:var(--theme-accent)]"
                        />
                      ) : isReady ? (
                        <div className="h-2.5 w-2.5 rounded-full bg-[var(--theme-accent)] shadow-[0_0_0_4px_var(--field-focus-ring)]" />
                      ) : (
                        <div className="h-3.5 w-3.5 rounded-full border-2 border-[color:var(--border-strong)]" />
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div
                        className={`font-medium ${
                          task.status === "done"
                            ? "line-through text-[color:var(--text-tertiary)]"
                            : isFailed
                              ? "text-inherit"
                              : "text-[color:var(--text-primary)]"
                        }`}
                      >
                        {task.text}
                      </div>

                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        {task.group ? (
                          <span className="rounded-full border border-[color:var(--border-soft)] px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-[color:var(--text-tertiary)]">
                            {task.group}
                          </span>
                        ) : null}
                        {isReady ? (
                          <span className="rounded-full bg-[var(--theme-accent)]/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--theme-accent)]">
                            Ready
                          </span>
                        ) : null}
                      </div>

                      {task.result && (
                        <div className="mt-2 rounded-[10px] border border-[color:var(--border-soft)] bg-white/70 px-2 py-1 text-[10px] text-[color:var(--text-secondary)] dark:bg-black/20">
                          {task.result}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

const SubAgentLivePanel = ({ run }: { run?: SubAgentRun }) => {
  if (!run) return null;
  const taskEntries = Object.entries(run.tasks);
  if (taskEntries.length === 0) return null;

  return (
    <div className="my-3 rounded-[14px] border border-[color:var(--border-soft)] bg-[var(--shell-surface)]/84 p-2.5">
      <div className="mb-2 text-[10px] uppercase tracking-[0.14em] text-[color:var(--text-tertiary)]">
        Sub-agent live
      </div>
      <div className="space-y-2">
        {taskEntries.map(([key, task]) => (
          <div
            key={key}
            className="rounded-[12px] border border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/90 p-2.5"
          >
            <div className="flex items-center justify-between text-[11px]">
              <span className="font-semibold text-[color:var(--text-primary)]">
                {task.title}
              </span>
              <span
                className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] ${
                  task.status === "error"
                    ? "bg-red-500/10 text-red-600 dark:text-red-300"
                    : task.status === "done"
                      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
                      : "bg-[var(--theme-accent)]/10 text-[color:var(--theme-accent)]"
                }`}
              >
                {task.status}
              </span>
            </div>
            <div className="mt-2 max-h-32 space-y-1 overflow-y-auto rounded-[10px] bg-black/[0.03] px-2 py-2 text-[11px] text-[color:var(--text-secondary)] dark:bg-white/[0.03]">
              {task.logs.map((log, idx) => (
                <div
                  key={`${key}-log-${idx}`}
                  className={`${log.kind === "error" ? "text-red-500 dark:text-red-300" : ""}`}
                >
                  {log.text}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const MODES = [
  {
    id: "fast",
    title: "Fast",
    description: "快速响应，适合日常问答",
  },
  {
    id: "advanced",
    title: "Advanced",
    description: "深度规划，执行复杂任务",
  },
] as const;

type ModeId = (typeof MODES)[number]["id"];

const formatToolStatus = (toolCall: ToolCall) => {
  const input = toolCall.input || {};
  const name = toolCall.name;
  const status = toolCall.status;

  const asLabel = (base: string) => {
    if (status === "running") return `${base}...`;
    if (status === "error") return `${base} failed.`;
    return `${base}.`;
  };

  if (name === "browser_click") {
    const target = input.element || input.text || input.ref || "element";
    return asLabel(`Clicking ${target}`);
  }
  if (name === "browser_type") {
    const text = input.text || input.value || "";
    const target = input.element || input.ref || "field";
    const clipped = text
      ? `"${String(text).slice(0, 32)}${String(text).length > 32 ? "…" : ""}"`
      : "text";
    return asLabel(`Typing ${clipped} into ${target}`);
  }
  if (name === "browser_navigate") {
    const url = input.url || "page";
    return asLabel(`Navigating to ${url}`);
  }
  if (name === "browser_snapshot") {
    return asLabel("Capturing a page snapshot");
  }
  if (name === "browser_inspect_visual") {
    const target = input.targetName || "target";
    return asLabel(`Inspecting ${target} visually`);
  }
  if (name === "browser_ask_visual") {
    const question = input.question || "visual question";
    const clipped = String(question).slice(0, 40);
    return asLabel(
      `Asking a visual question: ${clipped}${String(question).length > 40 ? "…" : ""}`,
    );
  }
  if (name === "browser_click_point") {
    return asLabel("Clicking a visual point");
  }
  if (name === "browser_type_point") {
    const text = input.text || "";
    const clipped = text
      ? `"${String(text).slice(0, 32)}${String(text).length > 32 ? "…" : ""}"`
      : "text";
    return asLabel(`Typing ${clipped} at a visual point`);
  }
  if (name === "manage_skills") {
    const action = input.action || "running";
    return asLabel(`Managing skills (${action})`);
  }
  if (name === "manage_todos" || name === "manage_complex_todos") {
    const mode = input.mode || "update";
    return asLabel(`Updating plan (${mode})`);
  }
  return asLabel(`Running ${name}`);
};

const ToolExecutionItem = ({
  toolCall,
  subAgentRun,
}: {
  toolCall: ToolCall;
  subAgentRun?: SubAgentRun;
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const label = formatToolStatus(toolCall);
  const statusTone =
    toolCall.status === "error"
      ? "bg-red-500/10 text-red-600 dark:text-red-300"
      : toolCall.status === "done"
        ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
        : "bg-[var(--theme-accent)]/10 text-[color:var(--theme-accent)]";

  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className={`w-full rounded-[12px] border px-2.5 py-2 text-left transition-all duration-200 ${
          isOpen
            ? "border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)] text-[color:var(--text-primary)]"
            : "border-transparent bg-transparent text-[color:var(--text-secondary)] hover:border-[color:var(--border-soft)] hover:bg-black/[0.025] dark:hover:bg-white/[0.02]"
        }`}
      >
        <div className="flex items-center gap-2.5">
          <div className="flex h-6 w-6 items-center justify-center rounded-[9px] bg-black/[0.045] text-[color:var(--text-secondary)] dark:bg-white/[0.05]">
            <Terminal size={13} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] font-medium text-[color:var(--text-primary)]">
              {label}
            </div>
            <div className="mt-0.5 text-[10px] uppercase tracking-[0.08em] text-[color:var(--text-tertiary)]">
              {toolCall.name}
            </div>
          </div>
          <div
            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] ${statusTone}`}
          >
            {toolCall.status}
          </div>
          <div className="text-[color:var(--text-tertiary)]">
            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </div>
        </div>
      </button>
      {isOpen && (
        <div className="mt-1.5 max-h-44 overflow-y-auto rounded-[12px] border border-[color:var(--border-soft)] bg-[var(--shell-surface)]/86 p-2 text-[11px] text-[color:var(--text-secondary)]">
          {toolCall.input !== undefined && (
            <div className="mb-2">
              <div className="mb-1 text-[10px] uppercase tracking-[0.12em] text-[color:var(--text-tertiary)]">
                Input
              </div>
              <pre className="whitespace-pre-wrap rounded-[9px] border border-[color:var(--border-soft)] bg-black/[0.03] p-1.5 text-[color:var(--text-secondary)] dark:bg-white/[0.03]">
                {typeof toolCall.input === "string"
                  ? toolCall.input
                  : JSON.stringify(toolCall.input, null, 2)}
              </pre>
            </div>
          )}
          {toolCall.name === "dispatch_sub_agent" && (
            <SubAgentLivePanel run={subAgentRun} />
          )}
          {toolCall.output !== undefined && (
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-[0.12em] text-[color:var(--text-tertiary)]">
                Output
              </div>
              <pre className="whitespace-pre-wrap rounded-[9px] border border-[color:var(--border-soft)] bg-black/[0.03] p-1.5 text-[color:var(--text-secondary)] dark:bg-white/[0.03]">
                {typeof toolCall.output === "string"
                  ? toolCall.output
                  : JSON.stringify(toolCall.output, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const WorkStatusItem = ({ label, text }: { label: string; text?: string }) => {
  return (
    <div className="rounded-[11px] border border-[color:var(--border-soft)] bg-black/[0.03] px-2 py-1.5 text-[11px] text-[color:var(--text-secondary)] dark:bg-white/[0.03]">
      <span className="font-semibold text-[color:var(--text-primary)]">
        {label}
      </span>
      {text ? <span className="ml-1 whitespace-pre-wrap">{text}</span> : null}
    </div>
  );
};

const WorkPanel = ({
  title,
  label,
  isOpen,
  onToggle,
  children,
}: {
  title: string;
  label: string;
  isOpen: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
}) => {
  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={onToggle}
        className={`w-full rounded-[16px] border px-2.5 py-2.5 text-left transition-all duration-200 ${
          isOpen
            ? "border-[color:var(--border-strong)] bg-[var(--shell-surface-strong)]/96"
            : "border-[color:var(--border-soft)] bg-[var(--shell-surface)]/84 hover:bg-[var(--shell-surface-strong)]/90"
        }`}
        style={{ boxShadow: "var(--shadow-soft)" }}
      >
        <div className="flex items-start justify-between gap-2.5">
          <div className="flex min-w-0 items-start gap-2.5">
            <div className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-[10px] bg-[var(--field-focus-ring)] text-[color:var(--theme-accent)]">
              <ListChecks size={14} />
            </div>
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-[0.14em] text-[color:var(--text-tertiary)]">
                Work trace
              </div>
              <div className="mt-0.5 text-[13px] font-semibold text-[color:var(--text-primary)]">
                {title}
              </div>
              <div className="mt-0.5 text-[10px] text-[color:var(--text-secondary)]">
                {label}
              </div>
            </div>
          </div>
          <div className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-full bg-black/[0.05] text-[color:var(--text-secondary)] dark:bg-white/[0.05]">
            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </div>
        </div>
      </button>
      <div
        className={`mt-1.5 overflow-hidden transition-all duration-300 ${isOpen ? "max-h-80 opacity-100" : "max-h-0 opacity-0"}`}
      >
        {children}
      </div>
    </div>
  );
};

const ThinkingBubble = ({
  thought,
  isThinking,
  durationSec,
  startedAt,
  defaultOpen = false,
}: {
  thought: string;
  isThinking: boolean;
  durationSec?: number;
  startedAt?: number;
  defaultOpen?: boolean;
}) => {
  const [isOpen, setIsOpen] = useState(defaultOpen || isThinking);
  const [liveSec, setLiveSec] = useState<number | null>(null);
  const trimmedThought = (thought || "").trim();

  useEffect(() => {
    if (!isThinking || !startedAt) {
      setLiveSec(null);
      return;
    }
    const tick = () => {
      const elapsed = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      setLiveSec(elapsed);
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [isThinking, startedAt]);

  useEffect(() => {
    if (isThinking) {
      setIsOpen(true);
    } else if (durationSec && !defaultOpen) {
      setIsOpen(false);
    }
  }, [isThinking, durationSec]);

  if (!trimmedThought) return null;

  const summary = isThinking
    ? `Thinking for ${liveSec || 1} seconds`
    : `Thought for ${durationSec || 1} seconds`;

  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="w-full rounded-[12px] border border-transparent px-1.5 py-1.5 text-left transition-colors hover:border-[color:var(--border-soft)] hover:bg-black/[0.025] dark:hover:bg-white/[0.02]"
      >
        <div className="flex items-center gap-2.5">
          <div className="flex h-6 w-6 items-center justify-center rounded-[9px] bg-[var(--field-focus-ring)] text-[color:var(--theme-accent)]">
            <BrainCircuit size={13} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[12px] font-medium text-[color:var(--text-primary)]">
              {isThinking ? "Thinking" : "Reasoning"}
            </div>
            <div className="text-[10px] uppercase tracking-[0.1em] text-[color:var(--text-tertiary)]">
              {summary}
            </div>
          </div>
          <div className="text-[color:var(--text-tertiary)]">
            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </div>
        </div>
      </button>
      {isOpen && (
        <div className="mt-2 whitespace-pre-wrap rounded-[14px] border border-[color:var(--border-soft)] bg-[var(--field-focus-ring)]/70 px-3 py-3 text-xs leading-relaxed text-[color:var(--text-secondary)]">
          {trimmedThought}
          {isThinking && (
            <span className="ml-1 inline-block h-4 w-2 animate-pulse align-middle bg-[var(--theme-accent)]/60" />
          )}
        </div>
      )}
    </div>
  );
};

const appendAssistantChunk = (
  prev: Message[],
  kind: "content" | "think",
  text: string,
  parentId?: string,
): Message[] => {
  const lastIndex = prev.length - 1;
  const lastMsg = prev[lastIndex];
  const canReuse = lastMsg?.role === "assistant" && !lastMsg.toolCalls;
  const baseMsg: Message = canReuse
    ? { ...lastMsg }
    : {
        role: "assistant",
        content: "",
        thought: "",
        isThinking: false,
        parentId,
      };
  const now = Date.now();
  const nextMsg: Message = {
    ...baseMsg,
    content:
      kind === "content" ? (baseMsg.content || "") + text : baseMsg.content,
    thought:
      kind === "think" ? (baseMsg.thought || "") + text : baseMsg.thought,
    isThinking: kind === "think",
    thoughtStartedAt:
      kind === "think"
        ? baseMsg.thoughtStartedAt || now
        : baseMsg.thoughtStartedAt,
    thoughtDurationSec:
      kind === "content" && baseMsg.thoughtStartedAt
        ? Math.max(1, Math.round((now - baseMsg.thoughtStartedAt) / 1000))
        : baseMsg.thoughtDurationSec,
  };
  if (canReuse) {
    return [...prev.slice(0, lastIndex), nextMsg];
  }
  return [...prev, nextMsg];
};

const closeThinkingIfAny = (prev: Message[]): Message[] => {
  for (let i = prev.length - 1; i >= 0; i -= 1) {
    const msg = prev[i];
    if (msg?.role === "assistant" && msg.isThinking) {
      const now = Date.now();
      const duration = msg.thoughtStartedAt
        ? Math.max(1, Math.round((now - msg.thoughtStartedAt) / 1000))
        : msg.thoughtDurationSec;
      const next = { ...msg, isThinking: false, thoughtDurationSec: duration };
      return [...prev.slice(0, i), next, ...prev.slice(i + 1)];
    }
  }
  return prev;
};

const withWorkSummaryForTurn = (
  messages: Message[],
  options: {
    turnId: string | null;
    elapsedSec: number;
    label?: string;
    closeThinking?: boolean;
  },
): Message[] => {
  const {
    turnId,
    elapsedSec,
    label = "Completed",
    closeThinking = true,
  } = options;
  const next = closeThinking ? closeThinkingIfAny(messages) : [...messages];
  if (!turnId) return next;

  const hasSummary = next.some(
    (msg) => msg.workSummary && msg.parentId === turnId,
  );
  if (hasSummary) return next;

  let userIndex = -1;
  for (let i = next.length - 1; i >= 0; i -= 1) {
    const msg = next[i];
    if (msg.role === "user" && msg.id === turnId) {
      userIndex = i;
      break;
    }
  }
  if (userIndex < 0) return next;

  const safeElapsed = Number.isFinite(elapsedSec)
    ? Math.max(1, Math.round(elapsedSec))
    : 1;
  const summaryMessage: Message = {
    role: "system",
    parentId: turnId,
    workSummary: {
      elapsedSec: safeElapsed,
      isWorking: false,
      currentLabel: label,
      isOpen: false,
    },
  };

  return [
    ...next.slice(0, userIndex + 1),
    summaryMessage,
    ...next.slice(userIndex + 1),
  ];
};

const injectHistoryWorkSummaries = (messages: Message[]): Message[] => {
  const turnIdsWithWork = new Set<string>();

  messages.forEach((msg) => {
    if (!msg.parentId || msg.role !== "assistant") return;
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      turnIdsWithWork.add(msg.parentId);
      return;
    }
    if (msg.thought && msg.thought.trim()) {
      turnIdsWithWork.add(msg.parentId);
      return;
    }
    if (msg.content && msg.content.trim()) {
      turnIdsWithWork.add(msg.parentId);
    }
  });

  if (turnIdsWithWork.size === 0) return messages;

  let next = [...messages];
  const orderedTurnIds = [...turnIdsWithWork].sort((a, b) => {
    const ai = next.findIndex((msg) => msg.role === "user" && msg.id === a);
    const bi = next.findIndex((msg) => msg.role === "user" && msg.id === b);
    return ai - bi;
  });

  orderedTurnIds.forEach((turnId) => {
    next = withWorkSummaryForTurn(next, {
      turnId,
      elapsedSec: 1,
      label: "Completed",
      closeThinking: false,
    });
  });
  return next;
};

const applyPersistedWorkSummaries = (
  messages: Message[],
  workSummaries: PersistedWorkSummaries,
): Message[] => {
  if (!workSummaries || typeof workSummaries !== "object") {
    return messages;
  }
  let next = [...messages];
  Object.entries(workSummaries).forEach(([turnId, summary]) => {
    if (!turnId || !summary) return;
    next = withWorkSummaryForTurn(next, {
      turnId,
      elapsedSec: summary.elapsedSec ?? 1,
      label: summary.label || "Completed",
      closeThinking: false,
    });
  });
  return next;
};

const parseToolArgs = (raw?: string) => {
  if (!raw || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

const cleanThinkTags = (raw: string): string => {
  if (!raw) return "";
  return raw.replace(/<think>/gi, "").replace(/<\/think>/gi, "");
};

const parseEventTime = (value?: string): number | null => {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
};

const stringifyWorkPayload = (value: any): string => {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const MAX_SUB_AGENT_LOGS = 60;

const buildWorkTimelineFromEvents = (
  events: PersistedWorkEvent[],
): { blocks: WorkRenderBlock[]; subAgentRuns: Record<string, SubAgentRun> } => {
  if (!Array.isArray(events) || events.length === 0) {
    return { blocks: [], subAgentRuns: {} };
  }

  const sorted = [...events].sort((a, b) => {
    const seqA = Number.isFinite(a?.seq as number) ? Number(a.seq) : 0;
    const seqB = Number.isFinite(b?.seq as number) ? Number(b.seq) : 0;
    if (seqA !== seqB) return seqA - seqB;
    const tsA = parseEventTime(a?.createdAt) || 0;
    const tsB = parseEventTime(b?.createdAt) || 0;
    return tsA - tsB;
  });

  const blocks: WorkRenderBlock[] = [];
  const toolBlockIndex = new Map<string, number>();
  const toolNameById = new Map<string, string>();
  const subAgentRuns: Record<string, SubAgentRun> = {};
  let activeDispatchToolId: string | null = null;

  let thoughtBuffer = "";
  let thoughtStartMs: number | null = null;
  let thoughtEndMs: number | null = null;

  const appendStatus = (label: string, text?: string) => {
    blocks.push({
      kind: "status",
      key: `status-${blocks.length}-${label}`,
      label,
      text,
    });
  };

  const flushThought = () => {
    const clean = cleanThinkTags(thoughtBuffer).trim();
    if (!clean) {
      thoughtBuffer = "";
      thoughtStartMs = null;
      thoughtEndMs = null;
      return;
    }
    const durationSec =
      thoughtStartMs !== null && thoughtEndMs !== null
        ? Math.max(1, Math.round((thoughtEndMs - thoughtStartMs) / 1000))
        : 1;
    blocks.push({
      kind: "thought",
      key: `thought-${blocks.length}-${thoughtStartMs || 0}`,
      thought: clean,
      durationSec,
    });
    thoughtBuffer = "";
    thoughtStartMs = null;
    thoughtEndMs = null;
  };

  const flushTextBuffers = () => flushThought();

  const ensureToolBlock = (toolId: string, fallbackName = "tool") => {
    const existing = toolBlockIndex.get(toolId);
    if (existing !== undefined) return existing;
    blocks.push({
      kind: "tool",
      key: `tool-${toolId}-${blocks.length}`,
      toolCall: {
        id: toolId,
        name: fallbackName,
        status: "running",
      },
    });
    const idx = blocks.length - 1;
    toolBlockIndex.set(toolId, idx);
    return idx;
  };

  const updateToolBlock = (toolId: string, patch: Partial<ToolCall>) => {
    const fallbackName = toolNameById.get(toolId) || "tool";
    const blockIndex = ensureToolBlock(toolId, fallbackName);
    const block = blocks[blockIndex];
    if (!block || block.kind !== "tool") return;
    block.toolCall = {
      ...block.toolCall,
      ...patch,
      id: toolId,
      name: patch.name || block.toolCall.name || fallbackName,
    };
    toolNameById.set(toolId, block.toolCall.name);
  };

  const appendSubAgentLog = (logs: SubAgentLog[], log: SubAgentLog) => {
    logs.push(log);
    if (logs.length > MAX_SUB_AGENT_LOGS) {
      logs.splice(0, logs.length - MAX_SUB_AGENT_LOGS);
    }
  };

  const upsertSubAgentRun = (
    toolCallId: string,
    rawPayload: Record<string, any>,
    eventMs: number,
  ) => {
    const assignment = rawPayload.assignment || {};
    const taskKey = String(
      assignment.task_index ||
        assignment.assignment_index ||
        assignment.role ||
        "task",
    );
    const titleParts = [];
    if (assignment.task_index) titleParts.push(`Task ${assignment.task_index}`);
    if (assignment.role) titleParts.push(`(${assignment.role})`);
    const title =
      titleParts.length > 0 ? titleParts.join(" ") : `Task ${taskKey}`;

    const run = subAgentRuns[toolCallId] || {
      startedAt: eventMs || Date.now(),
      tasks: {},
    };
    const task = run.tasks[taskKey] || {
      title,
      status: "running" as const,
      logs: [],
      buffers: {},
    };
    const logs = [...task.logs];
    const buffers = { ...(task.buffers || {}) };
    let status: "running" | "done" | "error" = task.status;

    const flushBuffer = (kind: "content" | "think") => {
      const value = buffers[kind];
      if (value && value.trim()) {
        appendSubAgentLog(logs, { kind, text: value.trim() });
      }
      buffers[kind] = "";
    };

    const pushChunk = (kind: "content" | "think", chunk: string) => {
      if (!chunk) return;
      const text = String(chunk);
      const current = (buffers[kind] || "") + text;
      const lines = current.split("\n");
      if (lines.length > 1) {
        for (let i = 0; i < lines.length - 1; i += 1) {
          const line = lines[i].trim();
          if (line) {
            appendSubAgentLog(logs, { kind, text: line });
          }
        }
        buffers[kind] = lines[lines.length - 1];
        return;
      }
      if (current.length > 120) {
        appendSubAgentLog(logs, { kind, text: current.trim() });
        buffers[kind] = "";
      } else {
        buffers[kind] = current;
      }
    };

    const subType = String(rawPayload.type || "").trim();
    if (subType === "content_chunk") {
      pushChunk("content", rawPayload.content || "");
    } else if (subType === "think_chunk") {
      pushChunk("think", rawPayload.content || "");
    } else if (subType === "tool_start") {
      flushBuffer("think");
      appendSubAgentLog(logs, {
        kind: "tool",
        text: `Tool start: ${rawPayload.tool_name || "tool"}`,
      });
      buffers.pendingTool = {
        name: rawPayload.tool_name || "tool",
      };
    } else if (subType === "tool_input") {
      const inputText = stringifyWorkPayload(rawPayload.args || {});
      appendSubAgentLog(logs, {
        kind: "tool",
        text: `Tool input:\n${inputText}`,
      });
      buffers.pendingTool = {
        ...(buffers.pendingTool || {}),
        input: inputText,
      };
    } else if (subType === "tool_output") {
      const outputText = stringifyWorkPayload(rawPayload.result || "");
      appendSubAgentLog(logs, {
        kind: "tool",
        text: `Tool output:\n${outputText}`,
      });
      buffers.pendingTool = {
        ...(buffers.pendingTool || {}),
        output: outputText,
      };
    } else if (subType === "error") {
      flushBuffer("think");
      flushBuffer("content");
      appendSubAgentLog(logs, {
        kind: "error",
        text: String(rawPayload.error || "Error"),
      });
      status = "error";
    } else if (subType === "done") {
      flushBuffer("think");
      flushBuffer("content");
      status = "done";
    } else if (subType === "sub_agent_start") {
      status = "running";
    }

    subAgentRuns[toolCallId] = {
      ...run,
      tasks: {
        ...run.tasks,
        [taskKey]: {
          ...task,
          title,
          status,
          logs,
          buffers,
        },
      },
    };
  };

  const summarizeSubAgentPayload = (
    rawPayload: Record<string, any>,
  ): string => {
    const subType = String(rawPayload.type || "").trim();
    if (!subType) return "sub-agent event";
    if (subType === "think_chunk")
      return `sub-agent think: ${String(rawPayload.content || "")}`;
    if (subType === "content_chunk")
      return `sub-agent output: ${String(rawPayload.content || "")}`;
    if (subType === "tool_start")
      return `sub-agent tool start: ${String(rawPayload.tool_name || "tool")}`;
    if (subType === "tool_input")
      return `sub-agent tool input: ${stringifyWorkPayload(rawPayload.args || {})}`;
    if (subType === "tool_output")
      return `sub-agent tool output: ${stringifyWorkPayload(rawPayload.result || "")}`;
    if (subType === "error")
      return `sub-agent error: ${String(rawPayload.error || "error")}`;
    if (subType === "done") return "sub-agent done";
    return `sub-agent ${subType}`;
  };

  sorted.forEach((event, idx) => {
    const payload =
      event?.payload && typeof event.payload === "object"
        ? (event.payload as Record<string, any>)
        : {};
    const eventType =
      typeof event?.type === "string"
        ? event.type
        : typeof payload.type === "string"
          ? payload.type
          : "";
    const eventTs = parseEventTime(event?.createdAt);
    const eventMs = eventTs || Date.now();

    if (eventType === "think_chunk") {
      const chunk = typeof payload.content === "string" ? payload.content : "";
      if (!chunk) return;
      thoughtBuffer += chunk;
      if (eventTs !== null) {
        if (thoughtStartMs === null) {
          thoughtStartMs = eventTs;
        }
        thoughtEndMs = eventTs;
      }
      return;
    }

    if (eventType === "content_chunk") {
      // Assistant response content is rendered in main chat area, not in Work panel.
      flushThought();
      return;
    }

    flushTextBuffers();

    if (eventType === "tool_start") {
      const toolId = String(payload.id || `legacy-tool-${idx}`);
      const toolName = String(payload.name || "tool");
      toolNameById.set(toolId, toolName);
      updateToolBlock(toolId, {
        id: toolId,
        name: toolName,
        status: "running",
      });
      if (toolName === "dispatch_sub_agent") {
        activeDispatchToolId = toolId;
      }
      return;
    }

    if (eventType === "tool_input") {
      const toolId = String(payload.id || `legacy-tool-input-${idx}`);
      updateToolBlock(toolId, {
        status: "running",
        input: payload.args,
      });
      return;
    }

    if (eventType === "tool_output") {
      const toolId = String(payload.id || `legacy-tool-output-${idx}`);
      updateToolBlock(toolId, {
        status: "done",
        output: payload.result,
      });
      if (activeDispatchToolId === toolId) {
        activeDispatchToolId = null;
      }
      return;
    }

    if (eventType === "sub_agent_event") {
      const rawPayload =
        payload?.data && typeof payload.data === "object"
          ? (payload.data as Record<string, any>)
          : payload;
      if (activeDispatchToolId) {
        upsertSubAgentRun(activeDispatchToolId, rawPayload, eventMs);
      } else {
        appendStatus("Sub-agent", summarizeSubAgentPayload(rawPayload));
      }
      return;
    }

    if (eventType === "error") {
      const toolId =
        payload && typeof payload.id === "string" ? payload.id : "";
      if (toolId) {
        updateToolBlock(toolId, {
          status: "error",
          output:
            payload.error || payload.result || stringifyWorkPayload(payload),
        });
        if (activeDispatchToolId === toolId) {
          activeDispatchToolId = null;
        }
      } else {
        appendStatus("Error", String(payload.error || "Unknown error"));
      }
      return;
    }

    if (eventType === "stopped") {
      appendStatus("Stopped");
      return;
    }

    if (eventType === "done") {
      return;
    }
  });

  flushThought();

  Object.values(subAgentRuns).forEach((run) => {
    Object.values(run.tasks).forEach((task) => {
      const buffers = task.buffers || {};
      if (buffers.think && buffers.think.trim()) {
        appendSubAgentLog(task.logs, {
          kind: "think",
          text: buffers.think.trim(),
        });
      }
      if (buffers.content && buffers.content.trim()) {
        appendSubAgentLog(task.logs, {
          kind: "content",
          text: buffers.content.trim(),
        });
      }
      task.buffers = {};
    });
  });

  return { blocks, subAgentRuns };
};

const splitAssistantHistoryText = (
  raw: string,
): { content: string; thought: string } => {
  const input = raw || "";
  if (!input) {
    return { content: "", thought: "" };
  }

  const openTag = "<think>";
  const closeTag = "</think>";
  let cursor = 0;
  let inThink = false;
  let content = "";
  let thought = "";

  while (cursor < input.length) {
    const nextTag = inThink ? closeTag : openTag;
    const nextIndex = input.indexOf(nextTag, cursor);
    if (nextIndex === -1) {
      const chunk = input.slice(cursor);
      if (inThink) {
        thought += chunk;
      } else {
        content += chunk;
      }
      break;
    }
    const chunk = input.slice(cursor, nextIndex);
    if (inThink) {
      thought += chunk;
    } else {
      content += chunk;
    }
    cursor = nextIndex + nextTag.length;
    inThink = !inThink;
  }

  return {
    content: cleanThinkTags(content).trim(),
    thought: cleanThinkTags(thought).trim(),
  };
};

const restoreMessagesFromHistory = (
  history: PersistedHistoryMessage[],
  workSummaries?: PersistedWorkSummaries,
): Message[] => {
  const restored: Message[] = [];
  let activeUserId: string | null = null;
  const toolIndexMap = new Map<
    string,
    { messageIndex: number; callIndex: number }
  >();

  history.forEach((item, index) => {
    if (item.role === "user") {
      const userId = item.client_message_id || `legacy-user-${index}`;
      activeUserId = userId;
      restored.push({
        role: "user",
        id: userId,
        content: item.content || "",
      });
      return;
    }

    if (
      item.role === "assistant" &&
      Array.isArray(item.tool_calls) &&
      item.tool_calls.length > 0
    ) {
      const toolCalls: ToolCall[] = item.tool_calls.map((call, callIndex) => {
        const callId = call.id || `legacy-tool-${index}-${callIndex}`;
        const toolCall: ToolCall = {
          id: callId,
          name: call.function?.name || "tool",
          status: "running",
          input: parseToolArgs(call.function?.arguments),
        };
        return toolCall;
      });

      const messageIndex = restored.length;
      restored.push({
        role: "assistant",
        parentId: activeUserId || undefined,
        toolCalls,
      });

      toolCalls.forEach((call, callIndex) => {
        toolIndexMap.set(call.id, { messageIndex, callIndex });
      });
      return;
    }

    if (item.role === "tool") {
      const toolCallId = item.tool_call_id || "";
      const target = toolIndexMap.get(toolCallId);
      if (target) {
        const message = restored[target.messageIndex];
        const call = message?.toolCalls?.[target.callIndex];
        if (call) {
          call.output = item.content || "";
          call.status = "done";
        }
      } else {
        restored.push({
          role: "assistant",
          parentId: activeUserId || undefined,
          toolCalls: [
            {
              id: toolCallId || `legacy-tool-output-${index}`,
              name: "tool",
              status: "done",
              output: item.content || "",
            },
          ],
        });
      }
      return;
    }

    if (item.role === "assistant" && item.content) {
      const parsed = splitAssistantHistoryText(item.content);
      restored.push({
        role: "assistant",
        parentId: activeUserId || undefined,
        content: parsed.content,
        thought: parsed.thought || undefined,
        isThinking: false,
      });
    }
  });

  const withPersistedSummaries = applyPersistedWorkSummaries(
    restored,
    workSummaries || {},
  );
  return injectHistoryWorkSummaries(withPersistedSummaries);
};

const formatSessionUpdatedAt = (value?: string) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
};

export function Sidebar({
  sessionId,
  collapsed = false,
  onMinWidthChange,
  activeTab,
}: {
  sessionId: string | null;
  collapsed?: boolean;
  onMinWidthChange?: (width: number) => void;
  activeTab?: TeachingContextSnapshot | null;
}) {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [chatSessions, setChatSessions] = useState<ChatSessionItem[]>([]);
  const [activeChatSessionId, setActiveChatSessionId] = useState<string | null>(
    null,
  );
  const [isSessionMenuOpen, setIsSessionMenuOpen] = useState(false);
  const [pendingDeleteSessionId, setPendingDeleteSessionId] = useState<
    string | null
  >(null);
  const [persistedWorkSummaries, setPersistedWorkSummaries] =
    useState<PersistedWorkSummaries>({});
  const [persistedWorkEvents, setPersistedWorkEvents] =
    useState<PersistedWorkEvents>({});

  // Gemini 风格模式状态
  const [currentMode, setCurrentMode] = useState<ModeId>("fast");
  const [isModeMenuOpen, setIsModeMenuOpen] = useState(false);
  const isModeLocked = messages.length > 0;

  // 新增：安全模式状态 和 待审批请求状态
  const [securityMode, setSecurityMode] = useState<"auto" | "god" | "manual">(
    "auto",
  );
  const [pendingApproval, setPendingApproval] =
    useState<ApprovalRequest | null>(null);

  // 新增：运行状态管理
  const [isProcessing, setIsProcessing] = useState(false); // AI 是否正在处理
  const [isInputAnimating, setIsInputAnimating] = useState(false);
  const [lastUserMessage, setLastUserMessage] = useState(""); // 用于显示当前处理的消息
  const [activityState, setActivityState] = useState<
    "idle" | "thinking" | "content" | "tool"
  >("idle");
  const [lastUserMessageId, setLastUserMessageId] = useState<string | null>(
    null,
  );
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [workingStartedAt, setWorkingStartedAt] = useState<number | null>(null);
  const [workingElapsedSec, setWorkingElapsedSec] = useState(0);
  const [workingCompletedSec, setWorkingCompletedSec] = useState<number | null>(
    null,
  );
  const [workingOpen, setWorkingOpen] = useState(false);
  const [currentActivityLabel, setCurrentActivityLabel] =
    useState("Working...");

  const [contextUsage, setContextUsage] = useState({
    usedTokens: 0,
    maxTokens: 200000,
    thresholdTokens: 180000,
    percent: 0,
    status: "ok" as "ok" | "warning" | "critical",
  });

  // [新增] 计划状态
  const [activePlan, setActivePlan] = useState<TaskItem[] | null>(null);
  const [subAgentRuns, setSubAgentRuns] = useState<Record<string, SubAgentRun>>(
    {},
  );
  const wsRef = useRef<WebSocket | null>(null);
  const sendTeachingPayload = useCallback((payload: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(payload));
    return true;
  }, []);
  const teaching = useTeachingModeState(
    activeTab || {},
    sendTeachingPayload,
  );
  const activeDispatchRef = useRef<string | null>(null);
  const messagesRef = useRef<Message[]>([]);
  const activeChatSessionIdRef = useRef<string | null>(null);
  const turnThoughtBufferRef = useRef<Record<string, string>>({});
  const lastUserMessageIdRef = useRef<string | null>(null);
  const activityIdleTimerRef = useRef<number | null>(null);
  const workingTimerRef = useRef<number | null>(null);
  const workingStartedAtRef = useRef<number | null>(null);
  const keepSessionMenuOpenRef = useRef(false);

  // 粘性滚动相关状态和引用
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const workBodyRef = useRef<HTMLDivElement>(null);
  const inputShellRef = useRef<HTMLDivElement>(null);
  const userBubbleRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const pendingFlyRef = useRef<string | null>(null);
  const flyAnimationRef = useRef<Animation | null>(null);
  const flyCleanupTimeoutRef = useRef<number | null>(null);
  const copyFeedbackTimerRef = useRef<number | null>(null);
  const [workAutoScroll, setWorkAutoScroll] = useState(true);
  const workAutoScrollingRef = useRef(false);
  const [autoScroll, setAutoScroll] = useState(true); // 默认为true，因为刚打开时通常希望看到最新消息
  const modeMenuRef = useRef<HTMLDivElement>(null);
  const sessionMenuRef = useRef<HTMLDivElement>(null);
  const createChatButtonRef = useRef<HTMLButtonElement>(null);
  const teachingButtonRef = useRef<HTMLButtonElement>(null);
  const headerModeControlRef = useRef<HTMLDivElement>(null);
  const headerSecurityControlRef = useRef<HTMLDivElement>(null);
  const headerConnectionControlRef = useRef<HTMLDivElement>(null);
  const headerContextControlRef = useRef<HTMLDivElement>(null);
  const preferredChatSessionIdRef = useRef<string | null>(null);

  // [新增] 用于记录 toolId 对应的 toolName，方便在 output 时查询
  // 因为 React State 更新是异步的，这里用 ref 或者临时变量更稳妥，但为了持久跨渲染，用 Ref
  const toolIdToNameRef = useRef<Record<string, string>>({});

  const setPreferredChatSession = (chatSessionId: string | null) => {
    activeChatSessionIdRef.current = chatSessionId;
    setActiveChatSessionId(chatSessionId);
    if (chatSessionId) {
      preferredChatSessionIdRef.current = chatSessionId;
      window.localStorage.setItem("active-chat-session-id", chatSessionId);
    } else {
      preferredChatSessionIdRef.current = null;
      window.localStorage.removeItem("active-chat-session-id");
    }
  };

  useEffect(() => {
    preferredChatSessionIdRef.current = window.localStorage.getItem(
      "active-chat-session-id",
    );
  }, []);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    activeChatSessionIdRef.current = activeChatSessionId;
  }, [activeChatSessionId]);

  const reportSidebarMinWidth = useCallback(() => {
    if (!onMinWidthChange) return;

    const primaryWidth =
      HEADER_SESSION_TRIGGER_MIN_WIDTH +
      Math.max(
        HEADER_ACTION_BUTTON_MIN_WIDTH,
        measureControlWidth(createChatButtonRef.current),
      ) +
      HEADER_CONTROL_GAP;
    const secondaryWidth = measureInlineControlsWidth(
      [
        headerModeControlRef.current,
        headerSecurityControlRef.current,
        headerConnectionControlRef.current,
        headerContextControlRef.current,
        teachingButtonRef.current,
      ],
      HEADER_CONTROL_GAP,
    );

    const minWidth = Math.ceil(
      Math.max(primaryWidth, secondaryWidth) + HEADER_HORIZONTAL_PADDING,
    );
    onMinWidthChange(minWidth);
  }, [onMinWidthChange]);

  useEffect(() => {
    if (!onMinWidthChange) return;

    const rafId = window.requestAnimationFrame(reportSidebarMinWidth);
    const observer = new ResizeObserver(reportSidebarMinWidth);

    [
      headerModeControlRef.current,
      headerSecurityControlRef.current,
      headerConnectionControlRef.current,
      headerContextControlRef.current,
      teachingButtonRef.current,
    ].forEach((node) => {
      if (node) observer.observe(node);
    });

    window.addEventListener("resize", reportSidebarMinWidth);

    return () => {
      window.cancelAnimationFrame(rafId);
      observer.disconnect();
      window.removeEventListener("resize", reportSidebarMinWidth);
    };
  }, [onMinWidthChange, reportSidebarMinWidth]);

  useEffect(() => {
    if (!onMinWidthChange || collapsed) return;
    const rafId = window.requestAnimationFrame(reportSidebarMinWidth);
    return () => window.cancelAnimationFrame(rafId);
  }, [
    onMinWidthChange,
    collapsed,
    reportSidebarMinWidth,
    activeChatSessionId,
    chatSessions,
    currentMode,
    securityMode,
    isConnected,
    contextUsage.usedTokens,
    contextUsage.maxTokens,
  ]);

  const setUserBubbleRef = useCallback((id?: string) => {
    return (node: HTMLDivElement | null) => {
      if (!id) return;
      if (node) {
        userBubbleRefs.current.set(id, node);
      } else {
        userBubbleRefs.current.delete(id);
      }
    };
  }, []);

  const animateInputToBubble = (target: HTMLDivElement) => {
    const shell = inputShellRef.current;
    if (!shell) return;

    if (flyAnimationRef.current) {
      flyAnimationRef.current.cancel();
      flyAnimationRef.current = null;
    }

    const textarea = shell.querySelector("textarea");
    const fromRect = textarea
      ? (textarea as HTMLTextAreaElement).getBoundingClientRect()
      : shell.getBoundingClientRect();
    const toRect = target.getBoundingClientRect();
    if (!fromRect.width || !fromRect.height || !toRect.width || !toRect.height)
      return;

    const ghost = target.cloneNode(true) as HTMLDivElement;
    ghost.style.position = "fixed";
    ghost.style.left = `${fromRect.left}px`;
    ghost.style.top = `${fromRect.top}px`;
    ghost.style.width = `${toRect.width}px`;
    ghost.style.height = `${toRect.height}px`;
    ghost.style.margin = "0";
    ghost.style.display = "block";
    ghost.style.zIndex = "30";
    ghost.style.pointerEvents = "none";
    ghost.style.transformOrigin = "top left";
    document.body.appendChild(ghost);

    const originalTargetStyle = {
      opacity: target.style.opacity,
      transform: target.style.transform,
      transition: target.style.transition,
      filter: target.style.filter,
    };

    target.style.transition =
      "opacity 240ms ease-out, transform 240ms ease-out, filter 240ms ease-out";
    target.style.opacity = "0";
    target.style.transform = "scale(0.98)";
    target.style.filter = "brightness(0.95)";

    const dx = toRect.left - fromRect.left;
    const dy = toRect.top - fromRect.top;

    const midX = dx * 0.55;
    const midY = dy * 0.55 - 18;
    const settleX = dx * 0.985;
    const settleY = dy * 0.985;
    const animation = ghost.animate(
      [
        {
          transform: "translate(0px, 0px)",
          borderRadius: "12px",
        },
        {
          transform: `translate(${midX}px, ${midY}px)`,
          borderRadius: "12px",
          offset: 0.6,
        },
        {
          transform: `translate(${settleX}px, ${settleY}px)`,
          borderRadius: "12px",
          boxShadow: "0 12px 28px rgba(0,0,0,0.24)",
          offset: 0.9,
        },
        {
          transform: `translate(${dx}px, ${dy}px)`,
          borderRadius: "12px",
          boxShadow: "0 8px 20px rgba(0,0,0,0.18)",
        },
      ],
      {
        duration: 520,
        easing: "cubic-bezier(0.2,0.9,0.15,1)",
        fill: "forwards",
      },
    );

    flyAnimationRef.current = animation;

    animation.onfinish = () => {
      animation.cancel();
      ghost.remove();
      target.style.opacity = "1";
      target.style.transform = "scale(1)";
      target.style.filter = "brightness(1)";
      if (flyCleanupTimeoutRef.current) {
        window.clearTimeout(flyCleanupTimeoutRef.current);
      }
      flyCleanupTimeoutRef.current = window.setTimeout(() => {
        target.style.opacity = originalTargetStyle.opacity;
        target.style.transform = originalTargetStyle.transform;
        target.style.filter = originalTargetStyle.filter;
        target.style.transition = originalTargetStyle.transition;
      }, 180);
      pendingFlyRef.current = null;
      setIsInputAnimating(false);
    };

    animation.oncancel = () => {
      ghost.remove();
      target.style.opacity = originalTargetStyle.opacity;
      target.style.transform = originalTargetStyle.transform;
      target.style.filter = originalTargetStyle.filter;
      target.style.transition = originalTargetStyle.transition;
      pendingFlyRef.current = null;
      setIsInputAnimating(false);
    };
  };

  const bumpActivity = (next: "thinking" | "content" | "tool") => {
    if (workingStartedAtRef.current === null) {
      const now = Date.now();
      workingStartedAtRef.current = now;
      setWorkingStartedAt(now);
      setWorkingCompletedSec(null);
      setWorkingElapsedSec(0);
      if (workingTimerRef.current !== null) {
        window.clearInterval(workingTimerRef.current);
      }
      workingTimerRef.current = window.setInterval(() => {
        if (workingStartedAtRef.current !== null) {
          const elapsed = Math.max(
            1,
            Math.round((Date.now() - workingStartedAtRef.current) / 1000),
          );
          setWorkingElapsedSec(elapsed);
        }
      }, 1000);
    }
    setActivityState(next);
    if (activityIdleTimerRef.current !== null) {
      window.clearTimeout(activityIdleTimerRef.current);
      activityIdleTimerRef.current = null;
    }
    // Tool execution can take seconds between start and output events.
    // Keep the UI in "tool" mode until tool_output/error/done arrives.
    if (next === "tool") {
      return;
    }
    activityIdleTimerRef.current = window.setTimeout(() => {
      setActivityState("idle");
      activityIdleTimerRef.current = null;
    }, 300);
  };

  const clearActivityTimer = () => {
    if (activityIdleTimerRef.current !== null) {
      window.clearTimeout(activityIdleTimerRef.current);
      activityIdleTimerRef.current = null;
    }
  };

  const stopWorkingTimer = () => {
    if (workingTimerRef.current !== null) {
      window.clearInterval(workingTimerRef.current);
      workingTimerRef.current = null;
    }
    if (workingStartedAtRef.current !== null) {
      const elapsed = Math.max(
        1,
        Math.round((Date.now() - workingStartedAtRef.current) / 1000),
      );
      setWorkingCompletedSec(elapsed);
      setWorkingElapsedSec(elapsed);
      workingStartedAtRef.current = null;
    }
  };

  const startWorkingTimerNow = () => {
    if (workingTimerRef.current !== null) {
      window.clearInterval(workingTimerRef.current);
      workingTimerRef.current = null;
    }
    const now = Date.now();
    workingStartedAtRef.current = now;
    setWorkingStartedAt(now);
    setWorkingCompletedSec(null);
    setWorkingElapsedSec(0);
    workingTimerRef.current = window.setInterval(() => {
      if (workingStartedAtRef.current !== null) {
        const elapsed = Math.max(
          1,
          Math.round((Date.now() - workingStartedAtRef.current) / 1000),
        );
        setWorkingElapsedSec(elapsed);
      }
    }, 1000);
  };

  const resetTransientState = () => {
    clearActivityTimer();
    stopWorkingTimer();
    setIsProcessing(false);
    setIsInputAnimating(false);
    setLastUserMessage("");
    setLastUserMessageId(null);
    lastUserMessageIdRef.current = null;
    setPendingApproval(null);
    setEditingMessageId(null);
    setWorkingOpen(false);
    setWorkingStartedAt(null);
    setWorkingElapsedSec(0);
    setWorkingCompletedSec(null);
    setCurrentActivityLabel("Working...");
    setActivityState("idle");
    setSubAgentRuns({});
    setPersistedWorkSummaries({});
    setPersistedWorkEvents({});
    turnThoughtBufferRef.current = {};
    activeDispatchRef.current = null;
    toolIdToNameRef.current = {};
  };

  // 滚动监听：判断用户是否"脱离"了底部
  const handleScroll = () => {
    const container = containerRef.current;
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    // 判断是否接近底部 (允许 50px 的误差)
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;

    if (isAtBottom) {
      // 用户回到底部了，恢复自动滚动
      if (!autoScroll) setAutoScroll(true);
    } else {
      // 用户向上滚了，暂停自动滚动
      if (autoScroll) setAutoScroll(false);
    }
  };

  const handleWorkScroll = () => {
    const container = workBodyRef.current;
    if (!container) return;
    if (workAutoScrollingRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = container;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 80;
    if (isAtBottom) {
      if (!workAutoScroll) setWorkAutoScroll(true);
    } else {
      if (workAutoScroll) setWorkAutoScroll(false);
    }
  };

  // 自动滚动执行：只在 messages 变化且 autoScroll 为 true 时触发
  useEffect(() => {
    if (autoScroll) {
      messagesEndRef.current?.scrollIntoView({
        behavior: isInputAnimating ? "auto" : "smooth",
      });
    }
  }, [
    messages,
    autoScroll,
    pendingApproval,
    workingOpen,
    workingElapsedSec,
    activityState,
    isInputAnimating,
  ]); // 保持主滚动锁底

  useEffect(() => {
    if (workAutoScroll) {
      const el = workBodyRef.current;
      if (!el) return;
      workAutoScrollingRef.current = true;
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      window.setTimeout(() => {
        workAutoScrollingRef.current = false;
      }, 120);
    }
  }, [workAutoScroll, messages, workingElapsedSec, activityState, workingOpen]);

  // WebSocket 初始化逻辑
  useEffect(() => {
    console.log("[Sidebar] Current sessionId:", sessionId); // 调试日志

    if (!sessionId) return; // 没有 Session ID 就不连

    const connect = async () => {
      try {
        // 1. 通过 IPC 向主进程获取 Brain 地址（支持端口自适应）
        const wsUrl = await window.api.getBrainUrl();
        console.log("[Sidebar] Connecting to Brain at:", wsUrl);

        const ws = new WebSocket(wsUrl);

        ws.onopen = () => {
          console.log("[Sidebar] WS Open. Sending sessionId:", sessionId);
          setIsConnected(true);
          // 第一件事：发送 Session ID
          const sessionPayload = JSON.stringify({
            sessionId,
            chatSessionId:
              preferredChatSessionIdRef.current ||
              activeChatSessionId ||
              undefined,
          });
          console.log("[Sidebar] Sending session payload:", sessionPayload);
          ws.send(sessionPayload);
        };

        ws.onmessage = (event) => {
          console.log("[Sidebar] WS received raw data:", event.data);
          try {
            const data = JSON.parse(event.data);
            console.log("[Sidebar] WS parsed data:", data);

            if (typeof data.type === "string" && data.type.startsWith("teaching_")) {
              teaching.ingestSocketEvent(data);
              return;
            }

            // 核心逻辑：拦截审批请求
            if (data.type === "approval_request") {
              console.log("🛑 Approval Requested:", data);
              setPendingApproval(data); // 触发 UI 渲染
              setAutoScroll(true); // 滚到底部让用户看到
              return;
            }

            if (data.type === "chat_sessions") {
              const sessions = Array.isArray(data.sessions)
                ? data.sessions
                : [];
              startTransition(() => {
                setChatSessions(sessions as ChatSessionItem[]);
              });
              const activeId =
                typeof data.activeChatSessionId === "string"
                  ? data.activeChatSessionId
                  : null;
              setPreferredChatSession(activeId);
              return;
            }

            if (data.type === "chat_history") {
              const history = Array.isArray(data.messages)
                ? (data.messages as PersistedHistoryMessage[])
                : [];
              const workSummaries =
                data.workSummaries && typeof data.workSummaries === "object"
                  ? (data.workSummaries as PersistedWorkSummaries)
                  : {};
              const workEvents =
                data.workEvents && typeof data.workEvents === "object"
                  ? (data.workEvents as PersistedWorkEvents)
                  : {};
              const loadedId =
                typeof data.chatSessionId === "string"
                  ? data.chatSessionId
                  : null;
              if (loadedId) {
                setPreferredChatSession(loadedId);
              }
              const restoredMessages = restoreMessagesFromHistory(
                history,
                workSummaries,
              );
              const sessionMode =
                typeof data.mode === "string" &&
                (data.mode === "fast" || data.mode === "advanced")
                  ? (data.mode as ModeId)
                  : "fast";
              startTransition(() => {
                resetTransientState();
                setInput("");
                setActivePlan(null);
                setPersistedWorkSummaries(workSummaries);
                setPersistedWorkEvents(workEvents);
                setMessages(restoredMessages);
                setCurrentMode(sessionMode);
                setAutoScroll(true);
              });
              if (keepSessionMenuOpenRef.current) {
                keepSessionMenuOpenRef.current = false;
                setIsSessionMenuOpen(true);
              } else {
                setIsSessionMenuOpen(false);
              }
              return;
            }

            // 处理不同类型的消息
            if (data.type === "content_chunk" || data.type === "think_chunk") {
              if (data.content == null) return;
              const kind = data.type === "think_chunk" ? "think" : "content";
              appendWorkEventForTurn(lastUserMessageIdRef.current, data);
              bumpActivity(kind === "think" ? "thinking" : "content");
              setCurrentActivityLabel(
                kind === "think" ? "Thinking..." : "Drafting response...",
              );
              if (kind === "think" && typeof data.content === "string") {
                const turnId = lastUserMessageIdRef.current;
                if (turnId) {
                  turnThoughtBufferRef.current[turnId] =
                    (turnThoughtBufferRef.current[turnId] || "") + data.content;
                }
              }
              setMessages((prev) =>
                appendAssistantChunk(
                  prev,
                  kind,
                  data.content,
                  lastUserMessageIdRef.current || undefined,
                ),
              );
            } else if (data.type === "tool_start") {
              appendWorkEventForTurn(lastUserMessageIdRef.current, data);
              bumpActivity("tool");
              setCurrentActivityLabel(`Running ${data.name}...`);
              setMessages((prev) => closeThinkingIfAny(prev));
              // [新增] 记录 ID -> Name 映射
              toolIdToNameRef.current[data.id] = data.name;

              if (data.name === "dispatch_sub_agent") {
                activeDispatchRef.current = data.id;
                setSubAgentRuns((prev) => ({
                  ...prev,
                  [data.id]: {
                    startedAt: Date.now(),
                    tasks: {},
                  },
                }));
              }

              setMessages((prev) => [
                ...prev,
                {
                  role: "assistant",
                  // 这是一个专门展示工具的消息
                  toolCalls: [
                    { id: data.id, name: data.name, status: "running" },
                  ],
                  parentId: lastUserMessageIdRef.current || undefined,
                },
              ]);
            } else if (data.type === "tool_input") {
              appendWorkEventForTurn(lastUserMessageIdRef.current, data);
              bumpActivity("tool");
              const label = formatToolStatus({
                id: data.id,
                name: toolIdToNameRef.current[data.id] || "tool",
                status: "running",
                input: data.args,
              });
              setCurrentActivityLabel(label);
              // 找到对应的工具卡片更新 Input
              setMessages((prev) =>
                prev.map((msg) => {
                  if (!msg.toolCalls) return msg;
                  const targetCall = msg.toolCalls.find(
                    (c) => c.id === data.id,
                  );
                  if (targetCall) {
                    // 更新 input
                    const newCalls = msg.toolCalls.map((c) =>
                      c.id === data.id ? { ...c, input: data.args } : c,
                    );
                    return { ...msg, toolCalls: newCalls };
                  }
                  return msg;
                }),
              );
            } else if (data.type === "tool_output") {
              appendWorkEventForTurn(lastUserMessageIdRef.current, data);
              clearActivityTimer();
              setActivityState("idle");
              setMessages((prev) => closeThinkingIfAny(prev));
              // [新增] 拦截逻辑
              const toolName = toolIdToNameRef.current[data.id];

              if (
                toolName === "manage_todos" ||
                toolName === "manage_complex_todos"
              ) {
                const tasks = parseMarkdownTodos(data.result);
                if (tasks.length > 0) {
                  setActivePlan(tasks);
                } else {
                  // 如果返回空（比如清空了），则隐藏面板
                  setActivePlan(null);
                }
              }

              // 找到对应的工具卡片更新 Output 和 Status
              setMessages((prev) =>
                prev.map((msg) => {
                  if (!msg.toolCalls) return msg;
                  const targetCall = msg.toolCalls.find(
                    (c) => c.id === data.id,
                  );
                  if (targetCall) {
                    const newCalls = msg.toolCalls.map((c) =>
                      c.id === data.id
                        ? { ...c, output: data.result, status: "done" as const }
                        : c,
                    );
                    return { ...msg, toolCalls: newCalls };
                  }
                  return msg;
                }),
              );
            } else if (data.type === "sub_agent_event") {
              appendWorkEventForTurn(lastUserMessageIdRef.current, data);
              const payload = data.data || {};
              const assignment = payload.assignment || {};
              const toolCallId = activeDispatchRef.current;
              if (!toolCallId) return;

              const taskKey = String(
                assignment.task_index ||
                  assignment.assignment_index ||
                  assignment.role ||
                  "task",
              );
              const titleParts = [];
              if (assignment.task_index)
                titleParts.push(`Task ${assignment.task_index}`);
              if (assignment.role) titleParts.push(`(${assignment.role})`);
              const title = titleParts.length
                ? titleParts.join(" ")
                : `Task ${taskKey}`;

              const appendLog = (logs: SubAgentLog[], log: SubAgentLog) => {
                const next = [...logs, log];
                return next.length > 60 ? next.slice(next.length - 60) : next;
              };

              setSubAgentRuns((prev) => {
                const existing = prev[toolCallId] || {
                  startedAt: Date.now(),
                  tasks: {},
                };
                const task = existing.tasks[taskKey] || {
                  title,
                  status: "running",
                  logs: [],
                  buffers: {},
                };
                let logs = task.logs;
                let status = task.status;
                const buffers = { ...(task.buffers || {}) };

                const flushBuffer = (kind: "content" | "think") => {
                  const value = buffers[kind];
                  if (value && value.trim()) {
                    logs = appendLog(logs, { kind, text: value.trim() });
                  }
                  buffers[kind] = "";
                };

                const pushChunk = (
                  kind: "content" | "think",
                  chunk: string,
                ) => {
                  if (!chunk) return;
                  const text = String(chunk);
                  const current = (buffers[kind] || "") + text;
                  const lines = current.split("\n");
                  if (lines.length > 1) {
                    for (let i = 0; i < lines.length - 1; i++) {
                      const line = lines[i].trim();
                      if (line) {
                        if (kind === "think") {
                          logs = appendLog(logs, { kind, text: line });
                        }
                      }
                    }
                    buffers[kind] = lines[lines.length - 1];
                    return;
                  }
                  if (current.length > 120) {
                    if (kind === "think") {
                      logs = appendLog(logs, { kind, text: current.trim() });
                      buffers[kind] = "";
                    } else {
                      buffers[kind] = current;
                    }
                  } else {
                    buffers[kind] = current;
                  }
                };

                if (payload.type === "content_chunk") {
                  pushChunk("content", payload.content);
                } else if (payload.type === "think_chunk") {
                  pushChunk("think", payload.content);
                } else if (payload.type === "tool_start") {
                  flushBuffer("think");
                  logs = appendLog(logs, {
                    kind: "tool",
                    text: `Tool start: ${payload.tool_name}`,
                  });
                  buffers.pendingTool = {
                    name: payload.tool_name,
                  };
                } else if (payload.type === "tool_input") {
                  const inputText = payload.args
                    ? JSON.stringify(payload.args, null, 2)
                    : "No input";
                  logs = appendLog(logs, {
                    kind: "tool",
                    text: `Tool input:\n${inputText}`,
                  });
                  buffers.pendingTool = {
                    ...(buffers.pendingTool || {}),
                    input: inputText,
                  };
                } else if (payload.type === "tool_output") {
                  const outputText = payload.result
                    ? String(payload.result)
                    : "No output";
                  logs = appendLog(logs, {
                    kind: "tool",
                    text: `Tool output:\n${outputText}`,
                  });
                  buffers.pendingTool = {
                    ...(buffers.pendingTool || {}),
                    output: outputText,
                  };
                } else if (payload.type === "error") {
                  flushBuffer("think");
                  logs = appendLog(logs, {
                    kind: "error",
                    text: payload.error || "Error",
                  });
                  status = "error";
                } else if (payload.type === "done") {
                  flushBuffer("think");
                  if (buffers.content && buffers.content.trim()) {
                    logs = appendLog(logs, {
                      kind: "content",
                      text: buffers.content.trim(),
                    });
                    buffers.content = "";
                  }
                  status = "done";
                } else if (payload.type === "sub_agent_start") {
                  status = "running";
                }

                return {
                  ...prev,
                  [toolCallId]: {
                    ...existing,
                    tasks: {
                      ...existing.tasks,
                      [taskKey]: {
                        ...task,
                        title,
                        status,
                        logs,
                        buffers,
                      },
                    },
                  },
                };
              });
            } else if (data.type === "status") {
              console.log("[Sidebar] Status update:", data.content);
            } else if (data.type === "context_usage") {
              setContextUsage({
                usedTokens: data.usedTokens ?? 0,
                maxTokens: data.maxTokens ?? 200000,
                thresholdTokens: data.thresholdTokens ?? 180000,
                percent: data.percent ?? 0,
                status: data.status ?? "ok",
              });
            } else if (data.type === "done") {
              appendWorkEventForTurn(lastUserMessageIdRef.current, data);
              console.log("[Sidebar] Generation complete");
              setIsProcessing(false);
              setLastUserMessage("");
              setWorkingOpen(false);
              const elapsed = workingStartedAtRef.current
                ? Math.max(
                    1,
                    Math.round(
                      (Date.now() - workingStartedAtRef.current) / 1000,
                    ),
                  )
                : workingCompletedSec || workingElapsedSec || 1;
              const turnId = lastUserMessageIdRef.current;
              clearActivityTimer();
              setActivityState("idle");
              stopWorkingTimer();
              setMessages((prev) =>
                withWorkSummaryForTurn(prev, {
                  turnId,
                  elapsedSec: elapsed,
                  label: "Completed",
                }),
              );
              persistWorkSummary(
                turnId,
                elapsed,
                "Completed",
                collectTurnThought(messagesRef.current, turnId),
              );
              if (turnId) {
                delete turnThoughtBufferRef.current[turnId];
              }
            } else if (data.type === "error") {
              appendWorkEventForTurn(lastUserMessageIdRef.current, data);
              console.error("[Sidebar] Error from server:", data.error);
              setIsProcessing(false);
              setLastUserMessage("");
              setWorkingOpen(false);
              const elapsed = workingStartedAtRef.current
                ? Math.max(
                    1,
                    Math.round(
                      (Date.now() - workingStartedAtRef.current) / 1000,
                    ),
                  )
                : workingCompletedSec || workingElapsedSec || 1;
              const turnId = lastUserMessageIdRef.current;
              clearActivityTimer();
              setActivityState("idle");
              stopWorkingTimer();
              setMessages((prev) =>
                withWorkSummaryForTurn(prev, {
                  turnId,
                  elapsedSec: elapsed,
                  label: "Completed",
                }),
              );
              persistWorkSummary(
                turnId,
                elapsed,
                "Completed",
                collectTurnThought(messagesRef.current, turnId),
              );
              if (turnId) {
                delete turnThoughtBufferRef.current[turnId];
              }
            } else {
              console.log("[Sidebar] Unknown message type:", data.type);
            }
          } catch (e) {
            console.error("[Sidebar] Failed to parse WS message:", e);
          }
        };

        ws.onclose = () => {
          console.log("[Sidebar] Disconnected from Brain");
          setIsConnected(false);
          // 简单重连逻辑
          setTimeout(connect, 3000);
        };

        ws.onerror = (error) => {
          console.error("[Sidebar] WebSocket error:", error);
          setIsConnected(false);
        };

        wsRef.current = ws;
      } catch (e) {
        console.error("[Sidebar] Connection failed:", e);
        setIsConnected(false);
        // 简单的重连机制
        setTimeout(connect, 3000);
      }
    }; // connect 函数结束

    connect();

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [sessionId]); // 依赖 sessionId

  const ensureReadyForSessionSwitch = () => {
    if (!wsRef.current || !isConnected) return false;
    if (isProcessing) {
      const confirmed = window.confirm("当前回答尚未完成，确定要切换会话吗？");
      if (!confirmed) return false;
      wsRef.current.send(JSON.stringify({ type: "stop_generation" }));
    }
    return true;
  };

  const handleCreateChatSession = () => {
    if (!ensureReadyForSessionSwitch()) return;
    keepSessionMenuOpenRef.current = false;
    wsRef.current?.send(JSON.stringify({ type: "create_chat_session" }));
    setIsSessionMenuOpen(false);
    setPendingDeleteSessionId(null);
  };

  const handleSwitchChatSession = (chatSessionId: string) => {
    if (!chatSessionId || chatSessionId === activeChatSessionId) {
      setIsSessionMenuOpen(false);
      keepSessionMenuOpenRef.current = false;
      return;
    }
    if (!ensureReadyForSessionSwitch()) return;
    setPreferredChatSession(chatSessionId);
    const sessionMeta = chatSessions.find(
      (session) => session.id === chatSessionId,
    );
    if (sessionMeta?.mode === "fast" || sessionMeta?.mode === "advanced") {
      setCurrentMode(sessionMeta.mode);
    }
    keepSessionMenuOpenRef.current = false;
    wsRef.current?.send(
      JSON.stringify({
        type: "switch_chat_session",
        chat_session_id: chatSessionId,
      }),
    );
    setIsSessionMenuOpen(false);
    setPendingDeleteSessionId(null);
  };

  const handleDeleteChatSession = (chatSessionId: string) => {
    if (!chatSessionId) return;
    if (pendingDeleteSessionId !== chatSessionId) {
      setPendingDeleteSessionId(chatSessionId);
      return;
    }
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    setPendingDeleteSessionId(null);
    const deletingActiveProcessing =
      isProcessing && chatSessionId === activeChatSessionId;
    if (deletingActiveProcessing) {
      ws.send(JSON.stringify({ type: "stop_generation" }));
    }
    ws.send(
      JSON.stringify({
        type: "delete_chat_session",
        chat_session_id: chatSessionId,
      }),
    );
    keepSessionMenuOpenRef.current = true;
    setChatSessions((prev) =>
      prev.filter((session) => session.id !== chatSessionId),
    );
  };

  const collectTurnThought = (
    source: Message[],
    turnId: string | null,
  ): string => {
    if (!turnId) return "";
    const thoughtFromMessages = source
      .filter(
        (msg) => msg.parentId === turnId && msg.thought && msg.thought.trim(),
      )
      .map((msg) => msg.thought?.trim() || "")
      .join("\n")
      .trim();
    const thoughtFromBuffer = (
      turnThoughtBufferRef.current[turnId] || ""
    ).trim();
    if (!thoughtFromMessages) return thoughtFromBuffer;
    if (!thoughtFromBuffer) return thoughtFromMessages;
    return thoughtFromBuffer.length > thoughtFromMessages.length
      ? thoughtFromBuffer
      : thoughtFromMessages;
  };

  const persistWorkSummary = (
    turnId: string | null,
    elapsedSec: number,
    label: string,
    thought?: string,
  ) => {
    if (!turnId) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const safeElapsed = Math.max(1, Math.round(elapsedSec || 1));
    const cleanThought = (thought || "").trim();
    const chatSessionId = activeChatSessionIdRef.current || undefined;
    ws.send(
      JSON.stringify({
        type: "upsert_work_summary",
        chat_session_id: chatSessionId,
        turn_id: turnId,
        elapsed_sec: safeElapsed,
        label,
        thought: cleanThought || undefined,
      }),
    );
    setPersistedWorkSummaries((prev) => ({
      ...prev,
      [turnId]: {
        ...(prev[turnId] || {}),
        elapsedSec: safeElapsed,
        label,
        thought: cleanThought || prev[turnId]?.thought || "",
        updatedAt: new Date().toISOString(),
      },
    }));
  };

  const clearPersistedWorkForTurn = useCallback((turnId: string | null) => {
    if (!turnId) return;
    setPersistedWorkEvents((prev) => {
      if (!(turnId in prev)) return prev;
      const next = { ...prev };
      delete next[turnId];
      return next;
    });
    setPersistedWorkSummaries((prev) => {
      if (!(turnId in prev)) return prev;
      const next = { ...prev };
      delete next[turnId];
      return next;
    });
  }, []);

  const appendWorkEventForTurn = useCallback(
    (turnId: string | null, payload: any) => {
      if (!turnId || !payload || typeof payload !== "object") return;
      const eventType = typeof payload.type === "string" ? payload.type : "";
      if (!eventType) return;
      const nowIso = new Date().toISOString();
      setPersistedWorkEvents((prev) => {
        const current = Array.isArray(prev[turnId]) ? prev[turnId] : [];
        let maxSeq = 0;
        current.forEach((item) => {
          const seq = Number(item?.seq);
          if (Number.isFinite(seq) && seq > maxSeq) {
            maxSeq = seq;
          }
        });
        const eventId =
          typeof crypto !== "undefined" &&
          typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const nextEvent: PersistedWorkEvent = {
          eventId,
          seq: maxSeq + 1,
          type: eventType,
          payload,
          createdAt: nowIso,
        };
        return {
          ...prev,
          [turnId]: [...current, nextEvent],
        };
      });
    },
    [],
  );

  const handleSend = () => {
    console.log(
      "[Sidebar] handleSend triggered. Input:",
      input,
      "Connected:",
      isConnected,
    );

    if (isInputAnimating) return;
    if (!input.trim() || !wsRef.current || !isConnected) return;

    if (editingMessageId) {
      clearPersistedWorkForTurn(editingMessageId);
      setMessages((prev) => {
        const idx = prev.findIndex((msg) => msg.id === editingMessageId);
        if (idx === -1) return prev;
        const trimmed = prev.slice(0, idx);
        return [
          ...trimmed,
          { role: "user", content: input, id: editingMessageId },
        ];
      });
      setLastUserMessage(input);
      setLastUserMessageId(editingMessageId);
      lastUserMessageIdRef.current = editingMessageId;
      turnThoughtBufferRef.current[editingMessageId] = "";
      setIsProcessing(true);
      clearActivityTimer();
      setActivityState("idle");
      setAutoScroll(true);
      setWorkingOpen(true);
      setWorkingStartedAt(null);
      setWorkingCompletedSec(null);
      setWorkingElapsedSec(0);
      workingStartedAtRef.current = null;
      stopWorkingTimer();
      startWorkingTimerNow();
      const payload = JSON.stringify({
        type: "rewrite_from",
        user_message_id: editingMessageId,
        new_content: input,
        mode: currentMode,
        chat_session_id: activeChatSessionId,
      });
      console.log("[Sidebar] Sending payload:", payload);
      wsRef.current.send(payload);
      setEditingMessageId(null);
      setInput("");
      return;
    }

    const messageId = crypto.randomUUID();
    clearPersistedWorkForTurn(messageId);
    setMessages((prev) => [
      ...prev,
      { role: "user", content: input, id: messageId },
    ]);
    turnThoughtBufferRef.current[messageId] = "";
    setLastUserMessage(input);
    setLastUserMessageId(messageId);
    lastUserMessageIdRef.current = messageId;
    setIsProcessing(true); // 开始处理
    clearActivityTimer();
    setActivityState("idle");
    setAutoScroll(true);
    setWorkingOpen(true);
    setWorkingStartedAt(null);
    setWorkingCompletedSec(null);
    setWorkingElapsedSec(0);
    workingStartedAtRef.current = null;
    stopWorkingTimer();
    startWorkingTimerNow();

    // 发送到 Brain - 修复格式，使用 message 而不是 content
    const payload = JSON.stringify({
      message: input,
      client_message_id: messageId,
      mode: currentMode,
      chat_session_id: activeChatSessionId,
    });
    console.log("[Sidebar] Sending payload:", payload);
    wsRef.current.send(payload);

    if (inputShellRef.current) {
      pendingFlyRef.current = messageId;
      setIsInputAnimating(true);
    }
    setInput("");
  };

  const handleRetryFrom = (userMessageId: string | undefined) => {
    if (!wsRef.current || !isConnected || !userMessageId) return;
    clearPersistedWorkForTurn(userMessageId);
    setMessages((prev) => {
      const idx = prev.findIndex((msg) => msg.id === userMessageId);
      if (idx === -1) return prev;
      return prev.slice(0, idx + 1);
    });
    const userMsg = messages.find((msg) => msg.id === userMessageId);
    setLastUserMessage(userMsg?.content || "");
    setLastUserMessageId(userMessageId);
    lastUserMessageIdRef.current = userMessageId;
    turnThoughtBufferRef.current[userMessageId] = "";
    setIsProcessing(true);
    clearActivityTimer();
    setActivityState("idle");
    setAutoScroll(true);
    setWorkingOpen(true);
    setWorkingStartedAt(null);
    setWorkingCompletedSec(null);
    setWorkingElapsedSec(0);
    workingStartedAtRef.current = null;
    stopWorkingTimer();
    startWorkingTimerNow();
    wsRef.current.send(
      JSON.stringify({
        type: "retry_from",
        user_message_id: userMessageId,
        chat_session_id: activeChatSessionId,
      }),
    );
  };

  const handleCopy = async (text: string, messageId?: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      if (messageId) {
        setCopiedMessageId(messageId);
        if (copyFeedbackTimerRef.current !== null) {
          window.clearTimeout(copyFeedbackTimerRef.current);
        }
        copyFeedbackTimerRef.current = window.setTimeout(() => {
          setCopiedMessageId(null);
          copyFeedbackTimerRef.current = null;
        }, 1600);
      }
    } catch (error) {
      console.error("[Sidebar] Copy failed:", error);
    }
  };

  const toggleWorkSummaryAt = (index: number) => {
    setMessages((prev) =>
      prev.map((msg, idx) => {
        if (idx !== index || !msg.workSummary) return msg;
        return {
          ...msg,
          workSummary: {
            ...msg.workSummary,
            isOpen: !msg.workSummary.isOpen,
          },
        };
      }),
    );
  };

  useEffect(() => {
    if (!isInputAnimating) return;
    const pendingId = pendingFlyRef.current;
    if (!pendingId) return;

    let attempts = 0;
    const tryStart = () => {
      const container = containerRef.current;
      if (container) {
        const { scrollTop, scrollHeight, clientHeight } = container;
        const isAtBottom = scrollHeight - scrollTop - clientHeight < 2;
        if (!isAtBottom && attempts < 12) {
          attempts += 1;
          requestAnimationFrame(tryStart);
          return;
        }
      }
      const target = userBubbleRefs.current.get(pendingId);
      if (target && inputShellRef.current) {
        animateInputToBubble(target);
        return;
      }
      attempts += 1;
      if (attempts < 12) {
        requestAnimationFrame(tryStart);
      } else {
        pendingFlyRef.current = null;
        setInput("");
        setIsInputAnimating(false);
      }
    };

    requestAnimationFrame(tryStart);
  }, [isInputAnimating, lastUserMessageId, messages.length]);

  useEffect(() => {
    return () => {
      if (flyAnimationRef.current) flyAnimationRef.current.cancel();
      if (flyCleanupTimeoutRef.current)
        window.clearTimeout(flyCleanupTimeoutRef.current);
      if (copyFeedbackTimerRef.current !== null) {
        window.clearTimeout(copyFeedbackTimerRef.current);
      }
    };
  }, []);

  const handleEdit = (
    messageId: string | undefined,
    content: string | undefined,
  ) => {
    if (!messageId || !content) return;
    setEditingMessageId(messageId);
    setInput(content);
  };

  // 新增：停止处理函数
  const handleStop = () => {
    console.log("[Sidebar] User requested to stop processing");

    // 1. 立即通知后端
    if (wsRef.current) {
      wsRef.current.send(JSON.stringify({ type: "stop_generation" }));
    }

    const elapsed = workingStartedAtRef.current
      ? Math.max(
          1,
          Math.round((Date.now() - workingStartedAtRef.current) / 1000),
        )
      : workingCompletedSec || workingElapsedSec || 1;
    const turnId = lastUserMessageIdRef.current;
    appendWorkEventForTurn(turnId, { type: "stopped" });
    setMessages((prev) =>
      withWorkSummaryForTurn(prev, {
        turnId,
        elapsedSec: elapsed,
        label: "Stopped",
      }),
    );
    persistWorkSummary(
      turnId,
      elapsed,
      "Stopped",
      collectTurnThought(messagesRef.current, turnId),
    );
    if (turnId) {
      delete turnThoughtBufferRef.current[turnId];
    }

    // 2. 🟢 立即重置前端状态，不要等！
    // 这样用户马上就能输入下一个问题
    setIsProcessing(false);
    setWorkingOpen(false);
    setLastUserMessage("");
    clearActivityTimer();
    setActivityState("idle");
    setLastUserMessageId(null);
    lastUserMessageIdRef.current = null;
    stopWorkingTimer();
  };

  // 新增：处理权限模式切换
  const toggleMode = (mode: string) => {
    setSecurityMode(mode as "auto" | "god" | "manual");
    wsRef.current?.send(JSON.stringify({ type: "set_security_mode", mode }));
  };

  useEffect(() => {
    if (!isModeMenuOpen && !isSessionMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (modeMenuRef.current && !modeMenuRef.current.contains(target)) {
        setIsModeMenuOpen(false);
      }
      if (sessionMenuRef.current && !sessionMenuRef.current.contains(target)) {
        setIsSessionMenuOpen(false);
        setPendingDeleteSessionId(null);
        keepSessionMenuOpenRef.current = false;
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [isModeMenuOpen, isSessionMenuOpen]);

  useEffect(() => {
    if (isModeLocked) {
      setIsModeMenuOpen(false);
    }
  }, [isModeLocked]);

  // 新增：处理批准/拒绝
  const handleApproval = (decision: "approved" | "rejected") => {
    if (!pendingApproval) return;

    console.log(`Sending approval response: ${decision}`);
    wsRef.current?.send(
      JSON.stringify({
        type: "approval_response",
        id: pendingApproval.id,
        decision,
      }),
    );
    setPendingApproval(null);
  };

  const formatTokens = (value: number) => {
    if (value >= 1000) {
      return `${(value / 1000).toFixed(0)}k`;
    }
    return `${value}`;
  };

  const ringColor =
    contextUsage.status === "critical"
      ? "#c2410c"
      : contextUsage.status === "warning"
        ? "#b7791f"
        : "var(--theme-accent)";

  const ringCircumference = 2 * Math.PI * 14;
  const ringOffset =
    ringCircumference * (1 - Math.min(contextUsage.percent, 1));
  const activeMode = MODES.find((mode) => mode.id === currentMode) || MODES[0];
  const currentChatSession =
    chatSessions.find((session) => session.id === activeChatSessionId) || null;
  const currentChatTitle = currentChatSession?.title || "新对话";
  const isTeachingActive = teaching.mode !== "chat";

  if (isTeachingActive) {
    return <TeachingWorkspace teaching={teaching} />;
  }

  return (
    <div className="relative flex h-full flex-col bg-[var(--assistant-surface)] text-[color:var(--text-primary)]">
      <div
        className={`flex h-full flex-col transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          collapsed
            ? "pointer-events-none translate-x-3 opacity-0"
            : "translate-x-0 opacity-100"
        }`}
      >
        <div className="space-y-2.5 border-b border-[color:var(--border-soft)] bg-[var(--assistant-surface)] px-3.5 py-2.5 transition-colors">
          <div className="flex items-center gap-2">
            <div
              ref={sessionMenuRef}
              className="relative min-w-0 flex-1"
              style={{ minWidth: HEADER_SESSION_TRIGGER_MIN_WIDTH }}
            >
              <button
                type="button"
                className="flex h-9 w-full items-center justify-between gap-2 rounded-[14px] border border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/92 px-2.5 text-left text-xs font-semibold text-[color:var(--text-primary)] transition-all hover:border-[color:var(--border-strong)] hover:bg-[var(--shell-surface-strong)]"
                style={{ boxShadow: "var(--shadow-soft)" }}
                onClick={() => {
                  setIsSessionMenuOpen((open) => {
                    const nextOpen = !open;
                    if (!nextOpen) {
                      setPendingDeleteSessionId(null);
                      keepSessionMenuOpenRef.current = false;
                    }
                    return nextOpen;
                  });
                }}
                aria-expanded={isSessionMenuOpen}
                aria-haspopup="menu"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <MessageSquare
                    size={13}
                    className="text-[color:var(--text-secondary)]"
                  />
                  <span className="truncate">{currentChatTitle}</span>
                </span>
                <ChevronDown
                  size={14}
                  className="text-[color:var(--text-secondary)]"
                />
              </button>

              {isSessionMenuOpen && (
                <div
                  className="absolute left-0 top-full z-50 mt-1.5 w-full rounded-[16px] border border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/96 p-1.5 backdrop-blur-xl"
                  style={{ boxShadow: "var(--shadow-lifted)" }}
                >
                  <div className="max-h-72 overflow-y-auto p-1">
                    {chatSessions.length === 0 ? (
                      <div className="px-3 py-2 text-xs text-[color:var(--text-secondary)]">
                        暂无历史会话
                      </div>
                    ) : (
                      chatSessions.map((session) => {
                        const isActive = session.id === activeChatSessionId;
                        return (
                          <div
                            key={session.id}
                            className={`mb-1 flex w-full items-start justify-between gap-2.5 rounded-[12px] px-2.5 py-2 text-left transition-colors last:mb-0 ${
                              isActive
                                ? "bg-[var(--field-focus-ring)]"
                                : "hover:bg-black/[0.035] dark:hover:bg-white/[0.03]"
                            }`}
                          >
                            <button
                              type="button"
                              className="min-w-0 flex-1 text-left"
                              onClick={() =>
                                handleSwitchChatSession(session.id)
                              }
                            >
                              <div className="truncate text-xs font-semibold text-[color:var(--text-primary)]">
                                {session.title || "新对话"}
                              </div>
                              {session.lastMessagePreview ? (
                                <div className="mt-0.5 truncate text-[11px] text-[color:var(--text-secondary)]">
                                  {session.lastMessagePreview}
                                </div>
                              ) : null}
                            </button>
                            <div className="flex shrink-0 items-center gap-1.5">
                              <div className="text-[10px] text-[color:var(--text-tertiary)]">
                                {formatSessionUpdatedAt(session.updatedAt)}
                              </div>
                              <button
                                type="button"
                                className={`rounded-md p-1 transition-colors ${
                                  pendingDeleteSessionId === session.id
                                    ? "text-emerald-600 hover:bg-emerald-100/60 dark:text-emerald-300 dark:hover:bg-emerald-900/30"
                                    : "text-[color:var(--text-tertiary)] hover:bg-black/[0.06] hover:text-red-500 dark:hover:bg-white/[0.06]"
                                }`}
                                onClick={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  handleDeleteChatSession(session.id);
                                }}
                                title={
                                  pendingDeleteSessionId === session.id
                                    ? "再次点击确认删除"
                                    : "删除会话"
                                }
                                aria-label={
                                  pendingDeleteSessionId === session.id
                                    ? `确认删除会话 ${session.title || "新对话"}`
                                    : `删除会话 ${session.title || "新对话"}`
                                }
                              >
                                {pendingDeleteSessionId === session.id ? (
                                  <Check size={13} />
                                ) : (
                                  <Trash2 size={13} />
                                )}
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              )}
            </div>

            <button
              ref={createChatButtonRef}
              type="button"
              onClick={handleCreateChatSession}
              disabled={!isConnected}
              className={`flex h-9 w-9 items-center justify-center rounded-[12px] border border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/92 text-[color:var(--text-secondary)] transition-all ${
                isConnected
                  ? "hover:border-[color:var(--border-strong)] hover:bg-[var(--shell-surface-strong)] hover:text-[color:var(--text-primary)]"
                  : "cursor-not-allowed opacity-40"
              }`}
              title="新建对话"
              style={{ boxShadow: "var(--shadow-soft)" }}
            >
              <Plus size={14} />
            </button>

            <button
              ref={teachingButtonRef}
              type="button"
              onClick={teaching.openTeachingSetup}
              className="flex h-9 items-center gap-1.5 rounded-[12px] border border-[color:var(--field-border-strong)] bg-[var(--field-focus-ring)] px-3 text-[11px] font-semibold text-[color:var(--theme-accent)] transition-all hover:brightness-95"
              title="进入教学模式"
              style={{ boxShadow: "var(--shadow-soft)" }}
            >
              <BookOpen size={14} />
              Teach
            </button>
          </div>

          <div className="flex items-center gap-2">
            <div ref={headerModeControlRef} className="relative">
              <div ref={modeMenuRef} className="relative">
                <button
                  type="button"
                  className={`flex h-7 items-center justify-between gap-1 rounded-full border border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/78 px-2.5 text-[11px] font-semibold text-[color:var(--text-primary)] transition-colors ${
                    isModeLocked
                      ? "cursor-default"
                      : "cursor-pointer hover:border-[color:var(--border-strong)] hover:bg-[var(--shell-surface-strong)]"
                  }`}
                  onClick={() => {
                    if (isModeLocked) return;
                    setIsModeMenuOpen((open) => !open);
                  }}
                  aria-expanded={isModeMenuOpen}
                  aria-haspopup="menu"
                  aria-disabled={isModeLocked}
                >
                  <span>{activeMode.title}</span>
                  {!isModeLocked && (
                    <ChevronDown
                      size={14}
                      className="text-[color:var(--text-secondary)]"
                    />
                  )}
                </button>

                {isModeMenuOpen && !isModeLocked && (
                  <div
                    className="absolute left-0 top-full z-50 mt-1.5 w-56 rounded-[16px] border border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/96 p-1.5 backdrop-blur-xl"
                    style={{ boxShadow: "var(--shadow-lifted)" }}
                  >
                    <div className="p-1">
                      {MODES.map((mode) => {
                        const isActive = mode.id === currentMode;
                        return (
                          <button
                            key={mode.id}
                            type="button"
                            className="flex w-full items-start justify-between gap-2.5 rounded-[12px] px-2.5 py-2 text-left transition-colors hover:bg-black/[0.035] dark:hover:bg-white/[0.03]"
                            onClick={() => {
                              setCurrentMode(mode.id);
                              setIsModeMenuOpen(false);
                            }}
                          >
                            <div className="min-w-0">
                              <div className="text-xs font-semibold text-[color:var(--text-primary)]">
                                {mode.title}
                              </div>
                              <div className="text-[11px] text-[color:var(--text-secondary)]">
                                {mode.description}
                              </div>
                            </div>
                            {isActive && (
                              <Check
                                size={14}
                                className="mt-0.5 text-[color:var(--theme-accent)]"
                              />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div
              ref={headerSecurityControlRef}
              className="flex h-7 items-center gap-1.5 rounded-full border border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/78 px-2"
            >
              <Shield
                size={12}
                className="text-[color:var(--text-secondary)]"
              />
              <select
                value={securityMode}
                onChange={(e) => toggleMode(e.target.value)}
                className="cursor-pointer bg-transparent text-xs font-semibold text-[color:var(--text-primary)] outline-none"
              >
                <option value="auto">Auto</option>
                <option value="god">God ⚡</option>
                <option value="manual">Manual</option>
              </select>
            </div>

            <div
              ref={headerConnectionControlRef}
              className="flex items-center gap-1.5 rounded-full border border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/78 px-2 py-[5px]"
            >
              <div
                className={`h-2 w-2 rounded-full ${isConnected ? "bg-emerald-500" : "bg-red-500"}`}
              />
              <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--text-secondary)]">
                {isConnected ? "online" : "offline"}
              </span>
            </div>

            <div
              ref={headerContextControlRef}
              className="ml-auto flex items-center gap-1.5 rounded-[14px] border border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/82 px-2 py-1.5"
              style={{ boxShadow: "var(--shadow-soft)" }}
            >
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-[0.12em] text-[color:var(--text-tertiary)]">
                  Context
                </div>
                <div className="text-[11px] font-medium text-[color:var(--text-secondary)]">
                  {formatTokens(contextUsage.usedTokens)} /{" "}
                  {formatTokens(contextUsage.maxTokens)}
                </div>
              </div>
              <svg width="30" height="30" viewBox="0 0 40 40">
                <circle
                  cx="20"
                  cy="20"
                  r="14"
                  fill="none"
                  stroke="var(--border-soft)"
                  strokeWidth="4"
                />
                <circle
                  cx="20"
                  cy="20"
                  r="14"
                  fill="none"
                  stroke={ringColor}
                  strokeWidth="4"
                  strokeLinecap="round"
                  strokeDasharray={ringCircumference}
                  strokeDashoffset={ringOffset}
                  transform="rotate(-90 20 20)"
                />
              </svg>
            </div>
          </div>
        </div>

        {/* [新增] 任务看板 - 只有当有计划时显示 */}
        {activePlan && <TaskBoard tasks={activePlan} />}

        {/* Chat Area - 核心背景色 */}
        <div
          ref={containerRef}
          onScroll={handleScroll}
          className="relative flex-1 overflow-y-auto bg-[var(--assistant-surface)] px-4 py-4 pb-32 text-[color:var(--text-primary)] transition-colors"
        >
          {(() => {
            const lastAssistantIndex = [...messages]
              .map((msg, index) => ({ msg, index }))
              .filter(
                ({ msg }) =>
                  msg.role === "assistant" &&
                  msg.content &&
                  msg.content.trim() !== "",
              )
              .map(({ index }) => index)
              .pop();
            const activeTurnId = lastUserMessageId;
            const lastAssistantIndexForTurn = [...messages]
              .map((msg, index) => ({ msg, index }))
              .filter(
                ({ msg }) =>
                  msg.role === "assistant" &&
                  msg.parentId === activeTurnId &&
                  msg.content &&
                  msg.content.trim() !== "",
              )
              .map(({ index }) => index)
              .pop();

            const lastAssistantIndexByTurn = new Map<string, number>();
            messages.forEach((item, itemIdx) => {
              if (
                item.role === "assistant" &&
                item.parentId &&
                item.content &&
                item.content.trim() !== ""
              ) {
                lastAssistantIndexByTurn.set(item.parentId, itemIdx);
              }
            });

            const rendered = messages.map((msg, idx) => {
              const assistantCopyId = msg.id || `assistant-${idx}`;
              const userCopyId = msg.id || `user-${idx}`;
              const isLatestForTurn = msg.parentId
                ? lastAssistantIndexByTurn.get(msg.parentId) === idx
                : false;
              const showAssistantActions =
                msg.role === "assistant" &&
                msg.content &&
                msg.content.trim() !== "" &&
                isLatestForTurn &&
                (!isProcessing || msg.parentId !== activeTurnId);

              if (msg.workSummary) {
                const turnId = msg.parentId || "";
                const workChildren = messages.filter(
                  (child) => child.parentId === msg.parentId,
                );
                const fallbackToolThoughtChildren = workChildren.filter(
                  (child) =>
                    !!(
                      (child.thought && child.thought.trim()) ||
                      (child.toolCalls && child.toolCalls.length > 0)
                    ),
                );
                const timelineEvents = turnId
                  ? persistedWorkEvents[turnId] || []
                  : [];
                const timeline = buildWorkTimelineFromEvents(timelineEvents);
                const timelineBlocks = timeline.blocks;
                const timelineSubAgentRuns = timeline.subAgentRuns;
                const hasTimeline = timelineBlocks.length > 0;
                const hasTimelineThought = timelineBlocks.some(
                  (block) => block.kind === "thought",
                );
                const persistedSummary = turnId
                  ? persistedWorkSummaries[turnId]
                  : undefined;
                const persistedThought = (
                  persistedSummary?.thought || ""
                ).trim();
                const hasRenderedFallbackThought =
                  fallbackToolThoughtChildren.some(
                    (child) => !!(child.thought && child.thought.trim()),
                  );
                const title = msg.workSummary.isWorking
                  ? `Working ${msg.workSummary.elapsedSec || 1}s`
                  : `Worked for ${msg.workSummary.elapsedSec || 1}s`;
                return (
                  <WorkPanel
                    key={`work-${idx}`}
                    title={title}
                    label={msg.workSummary.currentLabel}
                    isOpen={msg.workSummary.isOpen}
                    onToggle={() => toggleWorkSummaryAt(idx)}
                  >
                    <div
                      ref={workBodyRef}
                      onScroll={handleWorkScroll}
                      className="max-h-72 overflow-y-auto rounded-[18px] border border-[color:var(--border-soft)] bg-[color:var(--shell-surface)]/95 p-2.5 text-xs text-[color:var(--text-secondary)] shadow-[inset_0_1px_0_rgba(255,255,255,0.42)]"
                    >
                      {hasTimeline &&
                        timelineBlocks.map((block, blockIdx) => (
                          <div
                            key={`work-${idx}-timeline-${block.key}-${blockIdx}`}
                            className="mb-2 last:mb-0"
                          >
                            {block.kind === "thought" ? (
                              <ThinkingBubble
                                thought={block.thought}
                                isThinking={false}
                                durationSec={block.durationSec}
                                defaultOpen
                              />
                            ) : block.kind === "status" ? (
                              <WorkStatusItem
                                label={block.label}
                                text={block.text}
                              />
                            ) : (
                              <ToolExecutionItem
                                toolCall={block.toolCall}
                                subAgentRun={
                                  subAgentRuns[block.toolCall.id] ||
                                  timelineSubAgentRuns[block.toolCall.id]
                                }
                              />
                            )}
                          </div>
                        ))}
                      {!hasTimeline &&
                        fallbackToolThoughtChildren.map((child, childIdx) => (
                          <div
                            key={`work-${idx}-${childIdx}`}
                            className="mb-2 last:mb-0"
                          >
                            {child.thought && (
                              <ThinkingBubble
                                thought={child.thought}
                                isThinking={!!child.isThinking}
                                durationSec={child.thoughtDurationSec}
                                startedAt={child.thoughtStartedAt}
                                defaultOpen
                              />
                            )}
                            {child.toolCalls &&
                              child.toolCalls.map((toolCall, toolIdx) => (
                                <ToolExecutionItem
                                  key={`work-${idx}-tool-${toolIdx}`}
                                  toolCall={toolCall}
                                  subAgentRun={subAgentRuns[toolCall.id]}
                                />
                              ))}
                          </div>
                        ))}
                      {!hasTimeline &&
                        !hasRenderedFallbackThought &&
                        persistedThought && (
                          <ThinkingBubble
                            thought={persistedThought}
                            isThinking={false}
                            durationSec={msg.workSummary.elapsedSec}
                            defaultOpen
                          />
                        )}
                      {hasTimeline &&
                        !hasTimelineThought &&
                        persistedThought && (
                          <ThinkingBubble
                            thought={persistedThought}
                            isThinking={false}
                            durationSec={msg.workSummary.elapsedSec}
                            defaultOpen
                          />
                        )}
                      {!hasTimeline &&
                        fallbackToolThoughtChildren.length === 0 &&
                        !persistedThought && (
                          <div className="text-[11px] italic text-[color:var(--text-tertiary)]">
                            No persisted work details for this turn.
                          </div>
                        )}
                    </div>
                  </WorkPanel>
                );
              }

              const isActiveTurn =
                activeTurnId && msg.parentId === activeTurnId;
              const isAssistant = msg.role === "assistant";
              const hasParent = !!msg.parentId;
              const lastIndexForTurn = msg.parentId
                ? lastAssistantIndexByTurn.get(msg.parentId)
                : undefined;
              const isLatestAssistantForTurn =
                !hasParent || lastIndexForTurn === idx;
              const shouldRenderInMain =
                !msg.toolCalls &&
                (!isAssistant || isLatestAssistantForTurn) &&
                !(isActiveTurn && isAssistant && isProcessing);

              if (!shouldRenderInMain) return null;

              const shouldInsertLiveWork =
                isProcessing &&
                activeTurnId &&
                msg.role === "user" &&
                msg.id === activeTurnId;

              return (
                <React.Fragment key={idx}>
                  <div
                    className={`mb-4 flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`group flex flex-col gap-2 ${
                        msg.role === "assistant"
                          ? "w-full max-w-none"
                          : "max-w-[88%] items-end"
                      }`}
                    >
                      {msg.content && msg.content.trim() !== "" && (
                        <div
                          ref={
                            msg.role === "user"
                              ? setUserBubbleRef(msg.id)
                              : undefined
                          }
                          className={`text-[13px] leading-[1.6] ${
                            msg.role === "assistant"
                              ? "w-full rounded-[20px] border border-[color:var(--border-soft)] bg-[color:var(--shell-surface)]/92 px-3.5 py-2.5 text-[color:var(--text-primary)] shadow-[0_10px_24px_rgba(26,30,36,0.05)] backdrop-blur-sm"
                              : "inline-block max-w-full rounded-[20px] border border-[color:var(--border-soft)] bg-[color:var(--shell-surface-muted)] px-3.5 py-2.5 text-[color:var(--text-primary)] shadow-[0_8px_18px_rgba(26,30,36,0.08)]"
                          }`}
                        >
                          {msg.role === "assistant" ? (
                            <ReactMarkdown
                              remarkPlugins={[remarkGfm]}
                              components={{
                                p: ({ node, ...props }) => (
                                  <p className="mb-2.5 last:mb-0" {...props} />
                                ),
                                a: ({ node, ...props }) => {
                                  const href =
                                    typeof props.href === "string"
                                      ? props.href
                                      : "";
                                  const handleClick = (
                                    e: React.MouseEvent<HTMLAnchorElement>,
                                  ) => {
                                    if (!href) return;
                                    e.preventDefault();
                                    if (window.api?.tabNew) {
                                      window.api.tabNew(href);
                                    }
                                  };
                                  return (
                                    <a
                                      className="font-medium text-[color:var(--theme-accent)] underline underline-offset-4 transition-opacity hover:opacity-80"
                                      onClick={handleClick}
                                      href={href || undefined}
                                    >
                                      {props.children}
                                    </a>
                                  );
                                },
                                ul: ({ node, ...props }) => (
                                  <ul
                                    className="mb-2.5 ml-5 list-disc space-y-1 last:mb-0"
                                    {...props}
                                  />
                                ),
                                ol: ({ node, ...props }) => (
                                  <ol
                                    className="mb-2.5 ml-5 list-decimal space-y-1 last:mb-0"
                                    {...props}
                                  />
                                ),
                                li: ({ node, ...props }) => (
                                  <li className="pl-0.5" {...props} />
                                ),
                                table: ({ node, ...props }) => (
                                  <div className="my-2.5 overflow-x-auto rounded-[16px] border border-[color:var(--border-soft)] bg-[color:var(--shell-surface-strong)]">
                                    <table
                                      className="min-w-full border-collapse text-[12px]"
                                      {...props}
                                    />
                                  </div>
                                ),
                                thead: ({ node, ...props }) => (
                                  <thead
                                    className="bg-[color:var(--shell-surface-muted)]"
                                    {...props}
                                  />
                                ),
                                th: ({ node, ...props }) => (
                                  <th
                                    className="border border-[color:var(--border-soft)] px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-[color:var(--text-secondary)]"
                                    {...props}
                                  />
                                ),
                                td: ({ node, ...props }) => (
                                  <td
                                    className="border border-[color:var(--border-soft)] px-3 py-2 align-top text-[color:var(--text-primary)]"
                                    {...props}
                                  />
                                ),
                                code: ({ className, children, ...props }) => {
                                  const isInline = !className;
                                  if (isInline) {
                                    return (
                                      <code
                                        className="rounded-md border border-[color:var(--border-soft)] bg-[color:var(--shell-surface-muted)] px-1.5 py-0.5 text-[12px]"
                                        {...props}
                                      >
                                        {children}
                                      </code>
                                    );
                                  }
                                  return (
                                    <pre className="my-2.5 overflow-x-auto rounded-[16px] border border-[color:var(--border-soft)] bg-[color:var(--shell-surface-muted)] p-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.42)]">
                                      <code className={className} {...props}>
                                        {children}
                                      </code>
                                    </pre>
                                  );
                                },
                              }}
                            >
                              {msg.content || ""}
                            </ReactMarkdown>
                          ) : (
                            msg.content
                          )}
                        </div>
                      )}

                      {showAssistantActions && (
                        <div className="mt-1 flex items-center gap-2 opacity-0 transition-all duration-150 group-hover:translate-y-0 group-hover:opacity-100">
                          <button
                            onClick={() =>
                              handleCopy(msg.content || "", assistantCopyId)
                            }
                            className="flex h-7 w-7 items-center justify-center rounded-full border border-[color:var(--border-soft)] bg-[color:var(--shell-surface)]/94 text-[color:var(--text-secondary)] shadow-[0_6px_16px_rgba(26,30,36,0.06)] transition-colors hover:text-[color:var(--text-primary)]"
                            title={
                              copiedMessageId === assistantCopyId
                                ? "copied"
                                : "Copy"
                            }
                          >
                            <Copy size={12} />
                          </button>
                          {copiedMessageId === assistantCopyId && (
                            <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/15 dark:text-emerald-300">
                              copied
                            </span>
                          )}
                          <button
                            onClick={() => handleRetryFrom(msg.parentId)}
                            className="flex h-7 w-7 items-center justify-center rounded-full border border-[color:var(--border-soft)] bg-[color:var(--shell-surface)]/94 text-[color:var(--text-secondary)] shadow-[0_6px_16px_rgba(26,30,36,0.06)] transition-colors hover:text-[color:var(--text-primary)]"
                            title="Retry"
                          >
                            <RotateCw size={12} />
                          </button>
                        </div>
                      )}

                      {msg.role === "user" &&
                        msg.content &&
                        msg.content.trim() !== "" && (
                          <div className="mt-1 flex items-center gap-2 opacity-0 transition-all duration-150 group-hover:translate-y-0 group-hover:opacity-100">
                            <button
                              onClick={() =>
                                handleCopy(msg.content || "", userCopyId)
                              }
                              className="flex h-7 w-7 items-center justify-center rounded-full border border-[color:var(--border-soft)] bg-[color:var(--shell-surface)]/94 text-[color:var(--text-secondary)] shadow-[0_6px_16px_rgba(26,30,36,0.06)] transition-colors hover:text-[color:var(--text-primary)]"
                              title={
                                copiedMessageId === userCopyId
                                  ? "copied"
                                  : "Copy"
                              }
                            >
                              <Copy size={12} />
                            </button>
                            {copiedMessageId === userCopyId && (
                              <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/15 dark:text-emerald-300">
                                copied
                              </span>
                            )}
                            <button
                              onClick={() => handleEdit(msg.id, msg.content)}
                              className="flex h-7 w-7 items-center justify-center rounded-full border border-[color:var(--border-soft)] bg-[color:var(--shell-surface)]/94 text-[color:var(--text-secondary)] shadow-[0_6px_16px_rgba(26,30,36,0.06)] transition-colors hover:text-[color:var(--text-primary)]"
                              title="Edit"
                            >
                              <Pencil size={12} />
                            </button>
                          </div>
                        )}
                    </div>
                  </div>
                  {shouldInsertLiveWork &&
                    (() => {
                      const liveTurnEvents = activeTurnId
                        ? persistedWorkEvents[activeTurnId] || []
                        : [];
                      const liveTimeline =
                        buildWorkTimelineFromEvents(liveTurnEvents);
                      const liveBlocks = liveTimeline.blocks;
                      const hasLiveTimeline = liveBlocks.length > 0;
                      const hasRunningLiveTool = liveBlocks.some(
                        (block) =>
                          block.kind === "tool" &&
                          block.toolCall.status === "running",
                      );
                      return (
                        <WorkPanel
                          title={`Working ${workingElapsedSec || 1}s`}
                          label={currentActivityLabel}
                          isOpen={workingOpen}
                          onToggle={() => setWorkingOpen((prev) => !prev)}
                        >
                          <div
                            ref={workBodyRef}
                            onScroll={handleWorkScroll}
                            className="max-h-72 overflow-y-auto rounded-[18px] border border-[color:var(--border-soft)] bg-[color:var(--shell-surface)]/95 p-2.5 text-xs text-[color:var(--text-secondary)] shadow-[inset_0_1px_0_rgba(255,255,255,0.42)]"
                          >
                            {hasLiveTimeline
                              ? liveBlocks.map((block, blockIdx) => (
                                  <div
                                    key={`live-timeline-${block.key}-${blockIdx}`}
                                    className="mb-2 last:mb-0"
                                  >
                                    {block.kind === "thought" ? (
                                      <ThinkingBubble
                                        thought={block.thought}
                                        isThinking={false}
                                        durationSec={block.durationSec}
                                        defaultOpen
                                      />
                                    ) : block.kind === "status" ? (
                                      <WorkStatusItem
                                        label={block.label}
                                        text={block.text}
                                      />
                                    ) : (
                                      <ToolExecutionItem
                                        toolCall={block.toolCall}
                                        subAgentRun={
                                          subAgentRuns[block.toolCall.id] ||
                                          liveTimeline.subAgentRuns[
                                            block.toolCall.id
                                          ]
                                        }
                                      />
                                    )}
                                  </div>
                                ))
                              : messages
                                  .filter(
                                    (child) => child.parentId === activeTurnId,
                                  )
                                  .map((child, childIdx) => (
                                    <div
                                      key={`live-${childIdx}`}
                                      className="mb-2 last:mb-0"
                                    >
                                      {child.thought && (
                                        <ThinkingBubble
                                          thought={child.thought}
                                          isThinking={!!child.isThinking}
                                          durationSec={child.thoughtDurationSec}
                                          startedAt={child.thoughtStartedAt}
                                          defaultOpen
                                        />
                                      )}
                                      {child.toolCalls &&
                                        child.toolCalls.map(
                                          (toolCall, toolIdx) => (
                                            <ToolExecutionItem
                                              key={`live-tool-${toolIdx}`}
                                              toolCall={toolCall}
                                              subAgentRun={
                                                subAgentRuns[toolCall.id]
                                              }
                                            />
                                          ),
                                        )}
                                    </div>
                                  ))}
                            {activityState === "idle" &&
                              !hasRunningLiveTool && (
                                <div className="mt-2 flex items-center gap-1.5">
                                  <span className="typing-dot" />
                                  <span className="typing-dot" />
                                  <span className="typing-dot" />
                                </div>
                              )}
                          </div>
                        </WorkPanel>
                      );
                    })()}
                </React.Fragment>
              );
            });

            return rendered;
          })()}

          {/* typing dots moved into Work panel */}

          {/* 锚点 */}
          <div ref={messagesEndRef} />
        </div>

        {/* "回到底部" 按钮已移除 */}

        {/* 核心：审批请求卡片 (悬浮在输入框上方) */}
        {pendingApproval && (
          <div className="z-20 mx-3.5 mb-2.5 animate-in rounded-[20px] border border-amber-200/80 bg-[linear-gradient(180deg,rgba(255,249,238,0.98)_0%,rgba(255,241,210,0.96)_100%)] p-3.5 shadow-[0_16px_30px_rgba(120,78,12,0.15)] slide-in-from-bottom-4 dark:border-amber-700/50 dark:bg-[linear-gradient(180deg,rgba(66,42,9,0.88)_0%,rgba(43,29,10,0.9)_100%)]">
            <div className="flex items-start gap-2.5">
              <div className="rounded-[16px] border border-amber-200/80 bg-white/70 p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.65)] dark:border-amber-700/50 dark:bg-black/20">
                <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-center justify-between">
                  <h3 className="text-sm font-bold text-amber-950 dark:text-amber-100">
                    Security Alert
                  </h3>
                  <span className="rounded-full border border-red-200 bg-red-100 px-2 py-0.5 text-[10px] font-bold text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-300">
                    {pendingApproval.riskLevel}
                  </span>
                </div>

                <p className="mb-2 text-xs leading-5 text-amber-900/85 dark:text-amber-100/80">
                  AI 想要执行以下操作，需要您的批准：
                </p>

                <div className="mb-2.5 rounded-[16px] border border-amber-200/80 bg-white/72 p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.72)] dark:border-amber-800/70 dark:bg-black/35">
                  <div className="mb-2 flex items-center gap-2 border-b border-amber-100/90 pb-2 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-amber-700 dark:border-amber-800/50 dark:text-amber-300">
                    <Terminal size={12} />
                    {pendingApproval.toolName}
                  </div>
                  <pre className="max-h-40 overflow-x-auto overflow-y-auto whitespace-pre-wrap text-[11px] font-mono leading-5 text-slate-700 dark:text-slate-200">
                    {/* 智能展示关键参数 */}
                    {pendingApproval.toolName === "run_shell_command"
                      ? pendingApproval.args.command
                      : pendingApproval.toolName === "exec_command"
                        ? pendingApproval.args.cmd
                        : pendingApproval.toolName === "file_edit"
                          ? `path: ${pendingApproval.args?.path ?? ""}\n--- original_text ---\n${pendingApproval.args?.original_text ?? ""}\n--- new_text ---\n${pendingApproval.args?.new_text ?? ""}`
                          : pendingApproval.toolName === "write_stdin"
                            ? pendingApproval.args.chars
                            : pendingApproval.toolName === "run_python_code"
                              ? pendingApproval.args.code
                              : JSON.stringify(pendingApproval.args, null, 2)}
                  </pre>
                </div>

                <div className="flex gap-2.5">
                  <button
                    onClick={() => handleApproval("rejected")}
                    className="flex flex-1 items-center justify-center gap-1 rounded-[16px] border border-amber-200/80 bg-white/72 px-3 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-white dark:border-amber-700/50 dark:bg-black/20 dark:text-slate-200 dark:hover:bg-black/35"
                  >
                    <Ban size={14} />
                    拒绝 (Deny)
                  </button>
                  <button
                    onClick={() => handleApproval("approved")}
                    className="flex flex-1 items-center justify-center gap-1 rounded-[16px] bg-amber-600 px-3 py-2 text-xs font-bold text-white shadow-[0_10px_22px_rgba(180,83,9,0.24)] transition-colors hover:bg-amber-700"
                  >
                    <CheckCircle size={14} />
                    批准执行 (Approve)
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Input Area */}
        <div
          ref={inputShellRef}
          className="absolute bottom-3 left-3.5 right-3.5 z-10 bg-transparent border-t-0 transition-colors"
        >
          {editingMessageId && (
            <div className="mb-2 flex items-start justify-between gap-2.5 rounded-[16px] border border-[color:var(--border-soft)] bg-[color:var(--shell-surface)]/96 px-3 py-2 text-[11px] text-[color:var(--text-secondary)] shadow-[0_8px_16px_rgba(26,30,36,0.06)]">
              <div>
                <div className="font-semibold text-[color:var(--text-primary)]">
                  Editing
                </div>
                <div>Responses after edited messages will be overwritten.</div>
              </div>
              <button
                onClick={() => {
                  setEditingMessageId(null);
                  setInput("");
                }}
                className="h-7 rounded-full border border-[color:var(--border-soft)] px-2.5 text-[color:var(--text-secondary)] transition-colors hover:text-[color:var(--text-primary)]"
              >
                Cancel
              </button>
            </div>
          )}
          <div className="relative rounded-[24px] border border-[color:var(--border-soft)] bg-[color:var(--shell-surface)]/96 p-1 shadow-[0_18px_36px_rgba(26,30,36,0.14)] backdrop-blur-xl transition-colors">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (isProcessing) {
                    handleStop();
                  } else {
                    handleSend();
                  }
                }
              }}
              placeholder={
                isProcessing
                  ? "AI 正在思考/执行中... (点击停止或按 Enter 中断)"
                  : "Describe the next step..."
              }
              className={`h-[88px] w-full resize-none rounded-[20px] bg-transparent px-3 py-2.5 pr-11 text-[13px] leading-[1.6] text-[color:var(--text-primary)] placeholder:text-[color:var(--text-tertiary)] focus:outline-none focus:ring-0 focus:ring-offset-0 transition-colors ${
                isProcessing ? "opacity-80" : ""
              }`}
            />
            {isProcessing ? (
              <button
                onClick={handleStop}
                className="absolute bottom-3.5 right-3.5 flex h-8 w-8 items-center justify-center rounded-full bg-[#a63d2d] text-white shadow-[0_10px_20px_rgba(166,61,45,0.28)] transition-colors hover:bg-[#933628]"
                title="停止生成"
              >
                <Square size={14} fill="currentColor" />
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!isConnected || !input.trim() || isInputAnimating}
                className={`absolute bottom-3.5 right-3.5 flex h-8 w-8 items-center justify-center rounded-full border transition-colors ${
                  isConnected && input.trim() && !isInputAnimating
                    ? "border-[color:var(--theme-accent)] bg-[color:var(--theme-accent)] text-white shadow-[0_10px_20px_rgba(15,118,110,0.28)] hover:brightness-95"
                    : "cursor-not-allowed border-[color:var(--border-soft)] bg-[color:var(--shell-surface-muted)] text-[color:var(--text-tertiary)] opacity-80"
                }`}
              >
                <ArrowUp size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
