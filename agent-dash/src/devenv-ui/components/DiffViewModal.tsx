/** @jsxImportSource @opentui/solid */
import { ScrollBoxRenderable, TextAttributes } from "@opentui/core";
import { isDiffFileAddedOrDeleted } from "../core";
import { useRenderer } from "@opentui/solid";
import { createMemo, For, Show, createEffect, createSignal } from "solid-js";
import { uiColors } from "../colors";
import type { Discussion } from "../types";
import { GenericModal } from "./GenericModal";
import { formatHelpTextLines } from "./HelpText";
import { ScrollableContent } from "./ScrollableContent";
import { SearchHeader } from "./SearchHeader";

interface DiffViewModalProps {
  filePath: string;
  diff: string;
  currentFileIndex: number;
  totalFiles: number;
  selectedLine: number; // Controlled from parent due to OpenTUI keyboard limitation
  visualModeActive: boolean; // Is visual selection mode active (v key)
  visualModeStart: number; // Starting line of visual selection
  forceSplitView?: boolean | null; // null = auto (based on width), true = force split, false = force unified
  isNewFile?: boolean;
  isDeletedFile?: boolean;
  commentMode: boolean; // Is comment input mode active
  commentText: string; // Current comment text being typed
  discussions?: Discussion[]; // NEW: Comment threads to display inline
  currentHeadSHA?: string; // NEW: Current CR head SHA for outdated detection
  collapsedThreads?: Set<string>; // Set of collapsed thread IDs
  onSelectedLineChange: (line: number) => void; // Callback to update parent
  onSelectedSourceRangeChange?: (start?: number, end?: number) => void;
  onDiscussionLineIndicesChange?: (indices: number[]) => void;
  onSelectableLineCountChange?: (count: number) => void;
  onSelectedFindingIdsChange?: (ids: string[]) => void;
  onClose: () => void;
  onNavigateFile?: (direction: 1 | -1) => void;
  onScrollBoxReady?: (scrollBox: ScrollBoxRenderable) => void;
}

interface DiffLine {
  lineNumber: number; // Line number in the diff output
  type: "added" | "removed" | "context" | "header";
  content: string;
  oldLineNum?: number; // Original line number (for removed/context)
  newLineNum?: number; // New file line number (for added/context)
}

interface SplitDiffLine {
  lineNumber: number; // Index in the split view
  oldLine?: { lineNum?: number; content: string; type: "removed" | "context" };
  newLine?: { lineNum?: number; content: string; type: "added" | "context" };
  header?: string;
}

/**
 * DiffViewModal component with line selection.
 *
 * Enhanced with vim-style navigation (j/k/up/down) and line selection.
 *
 * IMPORTANT: Due to OpenTUI limitation (only ONE useKeyboard hook works per app),
 * keyboard events are handled in the PARENT component (app-opentui.tsx) and
 * passed down via controlled props (selectedLine + onSelectedLineChange).
 *
 * Features:
 * - Line-by-line diff rendering with selection
 * - Controlled line selection from parent
 * - Auto-scroll to keep selected line visible
 * - Mouse support for line selection
 * - Theme-driven colors
 *
 * Navigation (handled in parent):
 * - j/k or up/down: Navigate lines
 * - h/l and left/right: Scroll horizontally
 * - [/]/Shift+K/Shift+J: Navigate files
 * - ESC: Close modal
 */
export function DiffViewModal(props: DiffViewModalProps) {
  const renderer = useRenderer();

  let scrollBox: ScrollBoxRenderable;

  const dimensions = () => ({
    width: renderer.width,
    height: renderer.height,
  });

  // Create reactive memo for commentMode (in case props aren't reactive)
  const isCommentMode = createMemo(() => props.commentMode);

  // Parse unified diff into individual lines
  const parsedLines = createMemo((): DiffLine[] => {
    const lines: DiffLine[] = [];
    const diffLines = props.diff.split("\n");

    let oldLineNum = 0;
    let newLineNum = 0;
    let lineNumber = 0;

    for (const line of diffLines) {
      lineNumber++;

      // Skip diff header lines (---, +++, @@)
      if (line.startsWith("---") || line.startsWith("+++")) {
        lines.push({
          lineNumber,
          type: "header",
          content: line,
        });
        continue;
      }

      // Hunk header (@@ -10,7 +10,7 @@)
      if (line.startsWith("@@")) {
        const match = line.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/);
        if (match) {
          oldLineNum = parseInt(match[1], 10) - 1;
          newLineNum = parseInt(match[2], 10) - 1;
        }
        lines.push({
          lineNumber,
          type: "header",
          content: line,
        });
        continue;
      }

      // Added line
      if (line.startsWith("+")) {
        newLineNum++;
        lines.push({
          lineNumber,
          type: "added",
          content: line.slice(1),
          newLineNum,
        });
      }
      // Removed line
      else if (line.startsWith("-")) {
        oldLineNum++;
        lines.push({
          lineNumber,
          type: "removed",
          content: line.slice(1),
          oldLineNum,
        });
      }
      // Context line
      else if (line.startsWith(" ")) {
        oldLineNum++;
        newLineNum++;
        lines.push({
          lineNumber,
          type: "context",
          content: line.slice(1),
          oldLineNum,
          newLineNum,
        });
      }
      // Other lines (e.g., "\ No newline at end of file")
      else if (line.trim()) {
        lines.push({
          lineNumber,
          type: "context",
          content: line,
        });
      }
    }

    return lines;
  });

  // Detect truly new/deleted files. Addition-only/deletion-only hunks in existing files still support split view.
  const isFileAddedOrDeleted = createMemo(() => {
    return (
      props.isNewFile === true ||
      props.isDeletedFile === true ||
      isDiffFileAddedOrDeleted(props.diff)
    );
  });

  // Determine if we should use split view based on terminal width or forced override
  // Split view requires at least 160 columns for comfortable side-by-side viewing
  // forceSplitView: null = auto (based on width), true = force split, false = force unified
  // Added/deleted files always use unified view (no side-by-side comparison possible)
  const useSplitView = createMemo(() => {
    if (isFileAddedOrDeleted()) return false; // Force unified for added/deleted files
    if (props.forceSplitView === true) return true; // Force split
    if (props.forceSplitView === false) return false; // Force unified
    return dimensions().width >= 160; // Auto (based on width)
  });

  // Parse diff into split format (pairing old/new lines side-by-side)
  const splitLines = createMemo((): SplitDiffLine[] => {
    const lines: SplitDiffLine[] = [];
    const parsed = parsedLines();
    let lineNumber = 0;
    let i = 0;

    while (i < parsed.length) {
      const line = parsed[i];

      // Headers span both columns
      if (line.type === "header") {
        lines.push({
          lineNumber: lineNumber++,
          header: line.content,
        });
        i++;
        continue;
      }

      // Context lines appear on both sides
      if (line.type === "context") {
        lines.push({
          lineNumber: lineNumber++,
          oldLine: {
            lineNum: line.oldLineNum,
            content: line.content,
            type: "context",
          },
          newLine: {
            lineNum: line.newLineNum,
            content: line.content,
            type: "context",
          },
        });
        i++;
        continue;
      }

      // Handle added/removed lines - try to pair them
      if (line.type === "removed") {
        // Look ahead for added lines to pair with
        const removedLines: DiffLine[] = [line];
        let j = i + 1;

        // Collect consecutive removed lines
        while (j < parsed.length && parsed[j].type === "removed") {
          removedLines.push(parsed[j]);
          j++;
        }

        // Collect consecutive added lines
        const addedLines: DiffLine[] = [];
        while (j < parsed.length && parsed[j].type === "added") {
          addedLines.push(parsed[j]);
          j++;
        }

        // Pair up removed and added lines
        const maxLen = Math.max(removedLines.length, addedLines.length);
        for (let k = 0; k < maxLen; k++) {
          const removed = removedLines[k];
          const added = addedLines[k];

          lines.push({
            lineNumber: lineNumber++,
            oldLine: removed
              ? {
                  lineNum: removed.oldLineNum,
                  content: removed.content,
                  type: "removed",
                }
              : undefined,
            newLine: added
              ? {
                  lineNum: added.newLineNum,
                  content: added.content,
                  type: "added",
                }
              : undefined,
          });
        }

        i = j;
        continue;
      }

      // Standalone added line (no corresponding removed line)
      if (line.type === "added") {
        lines.push({
          lineNumber: lineNumber++,
          newLine: {
            lineNum: line.newLineNum,
            content: line.content,
            type: "added",
          },
        });
        i++;
        continue;
      }

      i++;
    }

    return lines;
  });

  // Filter out non-selectable lines (headers) - works for both unified and split
  const selectableLines = createMemo(() => {
    if (useSplitView()) {
      return splitLines().filter((line) => !line.header);
    }
    return parsedLines().filter((line) => line.type !== "header");
  });

  // Helper function to check if a line is within the visual selection range
  const isInVisualSelection = (lineIndex: number): boolean => {
    if (!props.visualModeActive) return false;

    const start = Math.min(props.visualModeStart, props.selectedLine);
    const end = Math.max(props.visualModeStart, props.selectedLine);

    return lineIndex >= start && lineIndex <= end;
  };

  const commentIndex = createMemo(() => {
    const index = new Map<string, Discussion[]>();
    const add = (key: string, discussion: Discussion) => {
      const bucket = index.get(key);
      if (bucket) bucket.push(discussion);
      else index.set(key, [discussion]);
    };

    for (const discussion of props.discussions ?? []) {
      // Position can be at discussion level or first note level (GitLab inconsistency)
      const position =
        discussion.position ||
        (discussion.notes && discussion.notes.length > 0
          ? discussion.notes[0].position
          : null);
      if (!position) continue;
      if (
        position.new_path !== props.filePath &&
        position.old_path !== props.filePath
      )
        continue;
      if (position.new_line) add(`new:${position.new_line}`, discussion);
      if (position.old_line) add(`old:${position.old_line}`, discussion);
    }

    return index;
  });

  const commentsForKeys = (keys: string[]): Discussion[] => {
    const seen = new Set<string>();
    const matches: Discussion[] = [];
    for (const key of keys) {
      for (const discussion of commentIndex().get(key) ?? []) {
        if (seen.has(discussion.id)) continue;
        seen.add(discussion.id);
        matches.push(discussion);
      }
    }
    return matches;
  };

  // Helper: Get comments for a specific line
  const getCommentsForLine = (line: DiffLine): Discussion[] => {
    if (line.type === "added" && line.newLineNum)
      return commentsForKeys([`new:${line.newLineNum}`]);
    if (line.type === "removed" && line.oldLineNum)
      return commentsForKeys([`old:${line.oldLineNum}`]);
    if (line.type === "context") {
      const keys: string[] = [];
      if (line.newLineNum) keys.push(`new:${line.newLineNum}`);
      if (line.oldLineNum) keys.push(`old:${line.oldLineNum}`);
      return commentsForKeys(keys);
    }
    return [];
  };

  // Helper: Get comments for a split view line (checks both old and new line)
  const getCommentsForSplitLine = (line: SplitDiffLine): Discussion[] => {
    const keys: string[] = [];
    if (line.oldLine?.lineNum) keys.push(`old:${line.oldLine.lineNum}`);
    if (line.newLine?.lineNum) keys.push(`new:${line.newLine.lineNum}`);
    return commentsForKeys(keys);
  };

  // Helper: Check if a comment is outdated (code changed since comment was made)
  const isCommentOutdated = (discussion: Discussion): boolean => {
    // Position can be at discussion level or first note level
    const position =
      discussion.position ||
      (discussion.notes && discussion.notes.length > 0
        ? discussion.notes[0].position
        : null);
    if (!position || !props.currentHeadSHA) return false;
    return position.head_sha !== props.currentHeadSHA;
  };

  // Helper: Format timestamp for display
  const formatTimestamp = (timestamp: string): string => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString();
  };

  // Use parent's collapsed threads state (controlled component pattern)
  const isCollapsed = (discussionId: string) =>
    props.collapsedThreads?.has(discussionId) || false;

  createEffect(() => {
    const lines = selectableLines();
    const commentIndices = lines.flatMap((line, index) => {
      const comments = useSplitView()
        ? getCommentsForSplitLine(line as SplitDiffLine)
        : getCommentsForLine(line as DiffLine);
      return comments.length ? [index] : [];
    });
    props.onDiscussionLineIndicesChange?.(commentIndices);
    props.onSelectableLineCountChange?.(lines.length);
    const selected = lines[props.selectedLine];
    const start = props.visualModeActive
      ? lines[props.visualModeStart]
      : selected;
    const sourceLine = (line: DiffLine | SplitDiffLine | undefined) => {
      if (!line) return undefined;
      if ("header" in line) return undefined;
      if ("newLineNum" in line) return line.newLineNum ?? line.oldLineNum;
      const splitLine = line as SplitDiffLine;
      return splitLine.newLine?.lineNum ?? splitLine.oldLine?.lineNum;
    };
    const selectedSourceLine = sourceLine(selected);
    const startSourceLine = sourceLine(start);
    props.onSelectedSourceRangeChange?.(
      startSourceLine === undefined || selectedSourceLine === undefined
        ? selectedSourceLine
        : Math.min(startSourceLine, selectedSourceLine),
      startSourceLine === undefined || selectedSourceLine === undefined
        ? selectedSourceLine
        : Math.max(startSourceLine, selectedSourceLine),
    );
    const selectedFindingIds = selected
      ? (useSplitView()
          ? getCommentsForSplitLine(selected as SplitDiffLine)
          : getCommentsForLine(selected as DiffLine)
        ).flatMap((discussion) =>
          discussion.findingId ? [discussion.findingId] : [],
        )
      : [];
    props.onSelectedFindingIdsChange?.(selectedFindingIds);

    // Auto-scroll when selected line changes.
    const next = props.selectedLine;

    // Wrap around if out of bounds
    if (next >= lines.length && lines.length > 0) {
      props.onSelectedLineChange(0);
      return;
    }
    if (next < 0 && lines.length > 0) {
      props.onSelectedLineChange(lines.length - 1);
      return;
    }

    // Auto-scroll to keep selected line visible
    if (!scrollBox) return;

    // Find the target line by searching through the wrapper box's children
    const wrapperBox = scrollBox.getChildren()[0];
    if (!wrapperBox) return;

    const target = wrapperBox.getChildren().find((child) => {
      return child.id === `line-${next}`;
    });

    if (!target) return;

    // Bring following line into view first. Inline discussions render between
    // selected line and following line, so this keeps comment content visible.
    const following = wrapperBox
      .getChildren()
      .find((child) => child.id === `line-${next + 1}`);
    if (following) scrollBox.scrollChildIntoView(following.id);

    // Keep selection visible without moving it during scrolling.
    scrollBox.scrollChildIntoView(target.id);
  });

  // Extract file extension for syntax highlighting
  const filetype = () => {
    const match = props.filePath.match(/\.([^.]+)$/);
    return match ? match[1] : undefined;
  };

  // Custom header showing filename, navigation, and mode indicators
  const customHeader = () => (
    <SearchHeader>
      <box
        flexDirection="row"
        justifyContent="space-between"
        alignItems="center"
        style={{ width: "100%" }}
      >
        <box flexDirection="row" gap={1} alignItems="center">
          <text fg={uiColors.textPrimary}>
            <b>{props.filePath}</b>
          </text>
          <text fg={uiColors.textMuted}>
            {"(" +
              String(props.currentFileIndex + 1) +
              "/" +
              String(props.totalFiles) +
              ")"}
          </text>
        </box>
        <box flexDirection="row" gap={1} alignItems="center">
          <Show when={props.visualModeActive}>
            <text fg={uiColors.warning}>VISUAL</text>
          </Show>
          <Show when={props.commentMode}>
            <text fg={uiColors.primary}>COMMENT</text>
          </Show>
          <Show when={useSplitView()}>
            <text fg={uiColors.success}>SPLIT</text>
          </Show>
          <Show when={!useSplitView()}>
            <text fg={uiColors.textMuted}>STAGGERED</text>
          </Show>
        </box>
      </box>
    </SearchHeader>
  );

  // Custom footer with context-sensitive help text
  const footerHelpLines = () =>
    formatHelpTextLines(
      props.commentMode
        ? [
            { key: "Type", action: "Comment" },
            { key: "Enter", action: "Linebreak" },
            { key: "Ctrl+Enter", action: "Submit" },
            { key: "Esc", action: "Cancel" },
          ]
        : [
            { key: "j/k", action: "Nav" },
            { key: "n/N", action: "Next/Prev" },
            { key: "v", action: "Visual" },
            { key: "c", action: "Comment" },
            { key: "Space", action: "Toggle finding" },
            { key: "s", action: "Split" },
            { key: "h/l ←/→", action: "Scroll" },
            { key: "[/]", action: "File" },
            { key: "e", action: "Edit" },
            { key: "Esc", action: "Close" },
          ],
      Math.max(1, Math.floor(dimensions().width * 0.9) - 4),
    );

  const customFooter = () => (
    <box paddingTop={1} flexShrink={0} flexDirection="column">
      <For each={footerHelpLines()}>
        {(line) => <text fg={uiColors.textMuted}>{line}</text>}
      </For>
    </box>
  );

  return (
    <GenericModal
      title="" // Not used, using custom header instead
      helpText="" // Not used, using custom footer instead
      widthPercent={0.9}
      heightPercent={(dimensions().height - 4) / dimensions().height} // Full height minus 4 lines
      customHeader={customHeader()}
      customFooter={customFooter()}
      onBackdropClick={props.onClose}
    >
      {/* Scrollable wrapper for diff content with line selection. */}
      <ScrollableContent
        axes={["x", "y"]}
        keyboardAxes={["x"]}
        onScrollBoxReady={(r) => {
          scrollBox = r;
          props.onScrollBoxReady?.(r);
        }}
      >
        {/* Render split view or unified view based on terminal width */}
        <Show
          when={useSplitView()}
          fallback={
            /* UNIFIED VIEW */
            <box paddingLeft={2} paddingRight={2}>
              <For each={parsedLines()}>
                {(line, index) => {
                  // Calculate this line's index in the selectable lines array (headers are excluded)
                  const selectableIndex = selectableLines().findIndex(
                    (l) => l.lineNumber === line.lineNumber,
                  );

                  // Skip headers from selection but still render them
                  if (line.type === "header") {
                    return (
                      <box paddingTop={0.5} paddingBottom={0.5}>
                        <text fg={uiColors.borderHighlight}>
                          {line.content}
                        </text>
                      </box>
                    );
                  }

                  // REACTIVE: Check if this line is selected (must be a function for reactivity!)
                  const isSelected = () =>
                    selectableIndex === props.selectedLine;

                  // REACTIVE: Check if line is in visual selection range
                  const isInSelection = () =>
                    isInVisualSelection(selectableIndex);

                  // Background color based on line type and selection.
                  const bgColor = () => {
                    // Current cursor line - brightest highlight
                    if (isSelected()) return uiColors.primary;

                    // Lines in visual selection - dimmer highlight
                    if (isInSelection()) return uiColors.bgSurface2;

                    // Diff line backgrounds.
                    switch (line.type) {
                      case "added":
                        return uiColors.diffAddedBg; // #24312b (subtle green tint)
                      case "removed":
                        return uiColors.diffRemovedBg; // #3c2a32 (subtle red tint)
                      case "context":
                        return uiColors.diffContextBg; // #181825 (mantle)
                      default:
                        return uiColors.bgBase;
                    }
                  };

                  // Foreground color based on line type and selection.
                  const fgColor = () => {
                    // Cursor line: dark text for high contrast on bright blue
                    if (isSelected()) return uiColors.bgBase;

                    // Visual selection: bright text for contrast on dim gray background
                    if (isInSelection()) return uiColors.textPrimary; // #cdd6f4 (bright)

                    // Diff text colors.
                    switch (line.type) {
                      case "added":
                        return uiColors.diffAdded; // #a6e3a1 (green)
                      case "removed":
                        return uiColors.diffRemoved; // #f38ba8 (red)
                      case "context":
                        return uiColors.diffContext; // #9399b2 (overlay2)
                      default:
                        return uiColors.textPrimary;
                    }
                  };

                  // Sign color (+ or -)
                  const signColor = () => {
                    // Cursor line: dark text
                    if (isSelected()) return uiColors.bgBase;

                    // Visual selection: keep original diff colors for readability
                    if (isInSelection()) {
                      switch (line.type) {
                        case "added":
                          return uiColors.diffAdded; // Green
                        case "removed":
                          return uiColors.diffRemoved; // Red
                        default:
                          return uiColors.textMuted;
                      }
                    }

                    // Normal: diff colors
                    switch (line.type) {
                      case "added":
                        return uiColors.diffAdded; // Green
                      case "removed":
                        return uiColors.diffRemoved; // Red
                      default:
                        return uiColors.textMuted;
                    }
                  };

                  // Line number display - ensure numbers are converted to strings
                  const lineNum = () => {
                    if (line.type === "added")
                      return `   ${String(line.newLineNum || "")}`;
                    if (line.type === "removed")
                      return `${String(line.oldLineNum || "")}   `;
                    if (line.type === "context")
                      return `${String(line.oldLineNum || "")} ${String(line.newLineNum || "")}`;
                    return "     ";
                  };

                  // Sign character
                  const sign = () => {
                    switch (line.type) {
                      case "added":
                        return "+";
                      case "removed":
                        return "-";
                      default:
                        return " ";
                    }
                  };
                  const findingComments = () =>
                    getCommentsForLine(line).filter(
                      (discussion) => discussion.findingId,
                    );

                  return (
                    <>
                      <box
                        id={`line-${selectableIndex}`}
                        flexDirection="row"
                        backgroundColor={bgColor()}
                        paddingLeft={1}
                        paddingRight={1}
                        onMouseUp={() => {
                          if (selectableIndex >= 0) {
                            props.onSelectedLineChange(selectableIndex);
                          }
                        }}
                      >
                        {/* Line numbers */}
                        <text
                          fg={
                            isSelected()
                              ? uiColors.bgBase
                              : isInSelection()
                                ? uiColors.textMuted
                                : uiColors.textMuted
                          }
                          flexShrink={0}
                          width={10}
                        >
                          {lineNum()}
                        </text>

                        {/* Sign (+/-/ ) */}
                        <text fg={signColor()} flexShrink={0} width={2}>
                          {sign()}
                        </text>

                        {/* Line content */}
                        <text fg={fgColor()} flexGrow={1}>
                          {line.content}
                        </text>
                        <Show when={findingComments().length > 0}>
                          <text
                            fg={
                              findingComments().some(
                                (discussion) => discussion.notes[0].resolved,
                              )
                                ? uiColors.success
                                : uiColors.warning
                            }
                            attributes={TextAttributes.BOLD}
                          >
                            {findingComments().some(
                              (discussion) => discussion.notes[0].resolved,
                            )
                              ? "☑"
                              : "☐"}
                          </text>
                        </Show>
                      </box>

                      {/* Render inline comments for this line - Timeline style */}
                      <Show when={getCommentsForLine(line).length > 0}>
                        <For each={getCommentsForLine(line)}>
                          {(discussion) => {
                            const isOutdated = isCommentOutdated(discussion);
                            const threadIsCollapsed = () =>
                              isCollapsed(discussion.id);
                            const notesCount = discussion.notes.length;

                            return (
                              <box
                                flexDirection="column"
                                backgroundColor={uiColors.bgBase}
                                paddingTop={1}
                                paddingBottom={1}
                                paddingLeft={12} // Indent from line numbers
                                paddingRight={2}
                              >
                                {/* Header row with status badges */}
                                <box
                                  flexDirection="row"
                                  gap={2}
                                  marginBottom={0.5}
                                >
                                  <Show when={discussion.findingId}>
                                    <text
                                      fg={
                                        discussion.notes[0].resolved
                                          ? uiColors.success
                                          : uiColors.warning
                                      }
                                      attributes={TextAttributes.BOLD}
                                    >
                                      {discussion.notes[0].resolved
                                        ? "☑ FIX"
                                        : "☐ FIX"}
                                    </text>
                                  </Show>
                                  <Show when={isOutdated}>
                                    <text
                                      fg={uiColors.warning}
                                      attributes={TextAttributes.BOLD}
                                    >
                                      ⚠ OUTDATED
                                    </text>
                                  </Show>
                                  <Show when={discussion.notes[0].resolved}>
                                    <text
                                      fg={uiColors.success}
                                      attributes={TextAttributes.BOLD}
                                    >
                                      ✓ Resolved
                                    </text>
                                  </Show>
                                  <Show
                                    when={
                                      !discussion.notes[0].resolved &&
                                      !isOutdated
                                    }
                                  >
                                    <text
                                      fg={uiColors.warning}
                                      attributes={TextAttributes.BOLD}
                                    >
                                      ● Open
                                    </text>
                                  </Show>
                                </box>

                                {/* Conversation Messages with Timeline */}
                                <Show when={!threadIsCollapsed()}>
                                  <box flexDirection="column">
                                    <For each={discussion.notes}>
                                      {(note, noteIndex) => {
                                        const isLastNote = () =>
                                          noteIndex() ===
                                          discussion.notes.length - 1;
                                        return (
                                          <box
                                            style={{
                                              width: "100%",
                                              flexDirection: "row",
                                              flexShrink: 0,
                                            }}
                                          >
                                            {/* Timeline Column */}
                                            <box
                                              style={{
                                                width: 4,
                                                flexDirection: "column",
                                                alignItems: "center",
                                                flexShrink: 0,
                                              }}
                                            >
                                              {/* Node */}
                                              <box
                                                style={{
                                                  width: 3,
                                                  height: 1,
                                                  justifyContent: "center",
                                                  alignItems: "center",
                                                }}
                                              >
                                                <text fg={uiColors.primary}>
                                                  ●
                                                </text>
                                              </box>

                                              {/* Vertical line */}
                                              <Show when={!isLastNote()}>
                                                <box
                                                  style={{
                                                    width: 1,
                                                    flexGrow: 1,
                                                    flexDirection: "column",
                                                  }}
                                                >
                                                  {/* Calculate approximate lines needed based on message length */}
                                                  {(() => {
                                                    const bodyLength =
                                                      note.body?.length || 0;
                                                    const lines = Math.max(
                                                      3,
                                                      Math.ceil(
                                                        bodyLength / 80,
                                                      ) + 2,
                                                    );
                                                    return Array(lines)
                                                      .fill(null)
                                                      .map((_, i) => (
                                                        <text
                                                          fg={
                                                            uiColors.bgSurface1
                                                          }
                                                        >
                                                          │
                                                        </text>
                                                      ));
                                                  })()}
                                                </box>
                                              </Show>
                                            </box>

                                            {/* Message Content */}
                                            <box
                                              style={{
                                                flexGrow: 1,
                                                flexDirection: "column",
                                                paddingLeft: 1,
                                                paddingBottom: 1.5,
                                              }}
                                            >
                                              {/* Message Header: Author + Time */}
                                              <box flexDirection="row" gap={1}>
                                                <text
                                                  fg={uiColors.textPrimary}
                                                  attributes={
                                                    TextAttributes.BOLD
                                                  }
                                                >
                                                  {note.author?.name ||
                                                    "Unknown"}
                                                </text>
                                                <text fg={uiColors.textMuted}>
                                                  {formatTimestamp(
                                                    note.created_at,
                                                  )}
                                                </text>
                                              </box>

                                              {/* Message Body */}
                                              <box
                                                style={{
                                                  width: "100%",
                                                  marginTop: 0.5,
                                                }}
                                              >
                                                <text
                                                  fg={uiColors.textSecondary}
                                                >
                                                  {note.body || "(no content)"}
                                                </text>
                                              </box>
                                            </box>
                                          </box>
                                        );
                                      }}
                                    </For>
                                  </box>
                                </Show>

                                {/* Collapsed state - show expand button */}
                                <Show when={threadIsCollapsed()}>
                                  <box
                                    flexDirection="row"
                                    gap={1}
                                    alignItems="center"
                                    marginBottom={1}
                                  >
                                    <text
                                      fg={uiColors.textPrimary}
                                      attributes={TextAttributes.BOLD}
                                    >
                                      {discussion.notes[0].author?.name ||
                                        "Unknown"}
                                    </text>
                                    <text fg={uiColors.textMuted}>
                                      {formatTimestamp(
                                        discussion.notes[0].created_at,
                                      )}
                                    </text>
                                    <text
                                      fg={uiColors.borderHighlight}
                                      attributes={TextAttributes.BOLD}
                                    >
                                      [t] Show {notesCount}{" "}
                                      {notesCount === 1
                                        ? "message"
                                        : "messages"}
                                    </text>
                                  </box>
                                </Show>
                              </box>
                            );
                          }}
                        </For>
                      </Show>

                      {/* Show comment input inline after the selected line */}
                      {isCommentMode() && isSelected() ? (
                        <box
                          flexDirection="row"
                          alignItems="center"
                          gap={1}
                          backgroundColor={uiColors.bgBase}
                          paddingLeft={1}
                          paddingRight={1}
                          flexGrow={1}
                        >
                          <text fg={uiColors.textPrimary}>
                            {String(props.commentText || "Comment here...")}█
                          </text>
                        </box>
                      ) : null}
                    </>
                  );
                }}
              </For>
            </box>
          }
        >
          {/* SPLIT VIEW */}
          <box paddingLeft={2} paddingRight={2}>
            <For each={splitLines()}>
              {(line) => {
                // Calculate this line's index in the selectable lines array
                const selectableIndex = selectableLines().findIndex(
                  (l) => l.lineNumber === line.lineNumber,
                );

                // Headers span both columns
                if (line.header) {
                  return (
                    <box paddingTop={0.5} paddingBottom={0.5}>
                      <text fg={uiColors.borderHighlight}>{line.header}</text>
                    </box>
                  );
                }

                // REACTIVE: Check if this line is selected
                const isSelected = () => selectableIndex === props.selectedLine;
                const findingComments = () =>
                  getCommentsForSplitLine(line).filter(
                    (discussion) => discussion.findingId,
                  );

                // REACTIVE: Check if line is in visual selection range
                const isInSelection = () =>
                  isInVisualSelection(selectableIndex);

                return (
                  <>
                    <box
                      id={`line-${selectableIndex}`}
                      flexDirection="row"
                      backgroundColor={
                        isSelected()
                          ? uiColors.primary
                          : isInSelection()
                            ? uiColors.bgSurface2
                            : uiColors.diffContextBg
                      }
                      onMouseUp={() => {
                        if (selectableIndex >= 0) {
                          props.onSelectedLineChange(selectableIndex);
                        }
                      }}
                    >
                      {/* LEFT PANEL (OLD/REMOVED) */}
                      <box
                        flexDirection="row"
                        width="50%"
                        paddingLeft={1}
                        paddingRight={1}
                        backgroundColor={
                          line.oldLine?.type === "removed"
                            ? isSelected()
                              ? uiColors.primary
                              : isInSelection()
                                ? uiColors.bgSurface2
                                : uiColors.diffRemovedBg
                            : isSelected()
                              ? uiColors.primary
                              : isInSelection()
                                ? uiColors.bgSurface2
                                : uiColors.diffContextBg
                        }
                      >
                        <text
                          fg={
                            isSelected() ? uiColors.bgBase : uiColors.textMuted
                          }
                          flexShrink={0}
                          width={5}
                        >
                          {line.oldLine?.lineNum
                            ? String(line.oldLine.lineNum)
                            : ""}
                        </text>
                        <text
                          fg={
                            isSelected()
                              ? uiColors.bgBase
                              : line.oldLine?.type === "removed"
                                ? uiColors.diffRemoved
                                : uiColors.diffContext
                          }
                          flexGrow={1}
                        >
                          {line.oldLine?.content || ""}
                        </text>
                      </box>

                      {/* RIGHT PANEL (NEW/ADDED) */}
                      <box
                        flexDirection="row"
                        width="50%"
                        paddingLeft={1}
                        paddingRight={1}
                        backgroundColor={
                          line.newLine?.type === "added"
                            ? isSelected()
                              ? uiColors.primary
                              : isInSelection()
                                ? uiColors.bgSurface2
                                : uiColors.diffAddedBg
                            : isSelected()
                              ? uiColors.primary
                              : isInSelection()
                                ? uiColors.bgSurface2
                                : uiColors.diffContextBg
                        }
                      >
                        <text
                          fg={
                            isSelected() ? uiColors.bgBase : uiColors.textMuted
                          }
                          flexShrink={0}
                          width={5}
                        >
                          {line.newLine?.lineNum
                            ? String(line.newLine.lineNum)
                            : ""}
                        </text>
                        <text
                          fg={
                            isSelected()
                              ? uiColors.bgBase
                              : line.newLine?.type === "added"
                                ? uiColors.diffAdded
                                : uiColors.diffContext
                          }
                          flexGrow={1}
                        >
                          {line.newLine?.content || ""}
                        </text>
                        <Show when={findingComments().length > 0}>
                          <text
                            fg={
                              findingComments().some(
                                (discussion) => discussion.notes[0].resolved,
                              )
                                ? uiColors.success
                                : uiColors.warning
                            }
                            attributes={TextAttributes.BOLD}
                          >
                            {findingComments().some(
                              (discussion) => discussion.notes[0].resolved,
                            )
                              ? "☑"
                              : "☐"}
                          </text>
                        </Show>
                      </box>
                    </box>

                    {/* Render inline comments for this line - Timeline style */}
                    <Show when={getCommentsForSplitLine(line).length > 0}>
                      <For each={getCommentsForSplitLine(line)}>
                        {(discussion) => {
                          const isOutdated = isCommentOutdated(discussion);
                          const threadIsCollapsed = () =>
                            isCollapsed(discussion.id);
                          const notesCount = discussion.notes.length;

                          return (
                            <box
                              flexDirection="column"
                              backgroundColor={uiColors.bgBase}
                              paddingTop={1}
                              paddingBottom={1}
                              paddingLeft={6} // Indent from edge
                              paddingRight={2}
                            >
                              {/* Header row with status badges */}
                              <box
                                flexDirection="row"
                                gap={2}
                                marginBottom={0.5}
                              >
                                <Show when={discussion.findingId}>
                                  <text
                                    fg={
                                      discussion.notes[0].resolved
                                        ? uiColors.success
                                        : uiColors.warning
                                    }
                                    attributes={TextAttributes.BOLD}
                                  >
                                    {discussion.notes[0].resolved
                                      ? "☑ FIX"
                                      : "☐ FIX"}
                                  </text>
                                </Show>
                                <Show when={isOutdated}>
                                  <text
                                    fg={uiColors.warning}
                                    attributes={TextAttributes.BOLD}
                                  >
                                    ⚠ OUTDATED
                                  </text>
                                </Show>
                                <Show when={discussion.notes[0].resolved}>
                                  <text
                                    fg={uiColors.success}
                                    attributes={TextAttributes.BOLD}
                                  >
                                    ✓ Resolved
                                  </text>
                                </Show>
                                <Show
                                  when={
                                    !discussion.notes[0].resolved && !isOutdated
                                  }
                                >
                                  <text
                                    fg={uiColors.warning}
                                    attributes={TextAttributes.BOLD}
                                  >
                                    ● Open
                                  </text>
                                </Show>
                              </box>

                              {/* Conversation Messages with Timeline */}
                              <Show when={!threadIsCollapsed()}>
                                <box flexDirection="column">
                                  <For each={discussion.notes}>
                                    {(note, noteIndex) => {
                                      const isLastNote = () =>
                                        noteIndex() ===
                                        discussion.notes.length - 1;
                                      return (
                                        <box
                                          style={{
                                            width: "100%",
                                            flexDirection: "row",
                                            flexShrink: 0,
                                          }}
                                        >
                                          {/* Timeline Column */}
                                          <box
                                            style={{
                                              width: 4,
                                              flexDirection: "column",
                                              alignItems: "center",
                                              flexShrink: 0,
                                            }}
                                          >
                                            {/* Node */}
                                            <box
                                              style={{
                                                width: 3,
                                                height: 1,
                                                justifyContent: "center",
                                                alignItems: "center",
                                              }}
                                            >
                                              <text fg={uiColors.primary}>
                                                ●
                                              </text>
                                            </box>

                                            {/* Vertical line */}
                                            <Show when={!isLastNote()}>
                                              <box
                                                style={{
                                                  width: 1,
                                                  flexGrow: 1,
                                                  flexDirection: "column",
                                                }}
                                              >
                                                {/* Calculate approximate lines needed based on message length */}
                                                {(() => {
                                                  const bodyLength =
                                                    note.body?.length || 0;
                                                  const lines = Math.max(
                                                    3,
                                                    Math.ceil(bodyLength / 80) +
                                                      2,
                                                  );
                                                  return Array(lines)
                                                    .fill(null)
                                                    .map((_, i) => (
                                                      <text
                                                        fg={uiColors.bgSurface1}
                                                      >
                                                        │
                                                      </text>
                                                    ));
                                                })()}
                                              </box>
                                            </Show>
                                          </box>

                                          {/* Message Content */}
                                          <box
                                            style={{
                                              flexGrow: 1,
                                              flexDirection: "column",
                                              paddingLeft: 1,
                                              paddingBottom: 1.5,
                                            }}
                                          >
                                            {/* Message Header: Author + Time */}
                                            <box flexDirection="row" gap={1}>
                                              <text
                                                fg={uiColors.textPrimary}
                                                attributes={TextAttributes.BOLD}
                                              >
                                                {note.author?.name || "Unknown"}
                                              </text>
                                              <text fg={uiColors.textMuted}>
                                                {formatTimestamp(
                                                  note.created_at,
                                                )}
                                              </text>
                                            </box>

                                            {/* Message Body */}
                                            <box
                                              style={{
                                                width: "100%",
                                                marginTop: 0.5,
                                              }}
                                            >
                                              <text fg={uiColors.textSecondary}>
                                                {note.body || "(no content)"}
                                              </text>
                                            </box>
                                          </box>
                                        </box>
                                      );
                                    }}
                                  </For>
                                </box>
                              </Show>

                              {/* Collapsed state - show expand button */}
                              <Show when={threadIsCollapsed()}>
                                <box
                                  flexDirection="row"
                                  gap={1}
                                  alignItems="center"
                                  marginBottom={1}
                                >
                                  <text
                                    fg={uiColors.textPrimary}
                                    attributes={TextAttributes.BOLD}
                                  >
                                    {discussion.notes[0].author?.name ||
                                      "Unknown"}
                                  </text>
                                  <text fg={uiColors.textMuted}>
                                    {formatTimestamp(
                                      discussion.notes[0].created_at,
                                    )}
                                  </text>
                                  <text
                                    fg={uiColors.borderHighlight}
                                    attributes={TextAttributes.BOLD}
                                  >
                                    [t] Show {notesCount}{" "}
                                    {notesCount === 1 ? "message" : "messages"}
                                  </text>
                                </box>
                              </Show>
                            </box>
                          );
                        }}
                      </For>
                    </Show>

                    {/* Show comment input inline after the selected line */}
                    {isCommentMode() && isSelected() ? (
                      <box
                        flexDirection="row"
                        alignItems="center"
                        gap={1}
                        backgroundColor={uiColors.bgBase}
                        borderStyle="single"
                        borderColor={uiColors.borderHighlight}
                        paddingLeft={1}
                        paddingRight={1}
                        flexGrow={1}
                      >
                        <text fg={uiColors.textPrimary}>
                          {String(props.commentText || "Comment here...")}█
                        </text>
                      </box>
                    ) : null}
                  </>
                );
              }}
            </For>
          </box>
        </Show>
      </ScrollableContent>
    </GenericModal>
  );
}
