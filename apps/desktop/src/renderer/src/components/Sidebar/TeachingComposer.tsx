import React from "react";
import { ArrowUp, Square } from "lucide-react";
import { TeachingViewMode } from "./teachingTypes";

interface TeachingComposerProps {
  mode: TeachingViewMode;
  value: string;
  placeholder: string;
  buttonLabel: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
}

export function TeachingComposer({
  mode,
  value,
  placeholder,
  buttonLabel,
  onChange,
  onSubmit,
}: TeachingComposerProps) {
  const isDisabled = !value.trim();

  return (
    <div className="absolute bottom-3 left-3.5 right-3.5 z-10">
      <div className="rounded-[24px] border border-[color:var(--border-soft)] bg-[color:var(--shell-surface)]/96 p-1 shadow-[0_18px_36px_rgba(26,30,36,0.14)] backdrop-blur-xl transition-colors">
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSubmit();
            }
          }}
          placeholder={placeholder}
          className="h-[96px] w-full resize-none rounded-[20px] bg-transparent px-3 py-2.5 pr-11 text-[13px] leading-[1.6] text-[color:var(--text-primary)] placeholder:text-[color:var(--text-tertiary)] focus:outline-none focus:ring-0"
        />
        <button
          type="button"
          onClick={onSubmit}
          disabled={isDisabled}
          className={`absolute bottom-3.5 right-3.5 flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
            isDisabled
              ? "cursor-not-allowed border border-[color:var(--border-soft)] bg-[color:var(--shell-surface-muted)] text-[color:var(--text-tertiary)] opacity-80"
              : mode === "processing"
                ? "border border-[color:var(--border-soft)] bg-[color:var(--shell-surface-muted)] text-[color:var(--text-primary)] hover:border-[color:var(--border-strong)]"
                : "border border-[color:var(--theme-accent)] bg-[color:var(--theme-accent)] text-white shadow-[0_10px_20px_rgba(15,118,110,0.28)] hover:brightness-95"
          }`}
          title={buttonLabel}
        >
          {mode === "processing" ? <Square size={14} fill="currentColor" /> : <ArrowUp size={16} />}
        </button>
      </div>
      <div className="mt-2 text-[10px] text-[color:var(--text-tertiary)]">
        {mode === "review"
          ? "可以继续用自然语言修订流程草稿。"
          : mode === "recording"
            ? "左侧照常操作，右侧补充你的备注。"
            : "等待开始教学。"}
      </div>
    </div>
  );
}

