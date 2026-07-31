/** @jsxImportSource @opentui/solid */
import { For, JSX, Show, createMemo } from 'solid-js';
import { RGBA } from '@opentui/core';
import { SearchHeader } from './SearchHeader';
import { FilterStatusBar } from './FilterStatusBar';
import { useTerminalDimensions } from '@opentui/solid';
import { uiColors } from '../colors';
import { TextAttributes } from '@opentui/core';
import { invokeGlobalSelectionMouseUpHandler } from '../selectionCopy';
import { HelpText, type HelpEntry } from './HelpText';

function hexToRgba(hex: string, alpha: number): RGBA {
  const normalized = hex.replace('#', '');
  if (normalized.length !== 6) return RGBA.fromHex(hex);

  const r = parseInt(normalized.slice(0, 2), 16) / 255;
  const g = parseInt(normalized.slice(2, 4), 16) / 255;
  const b = parseInt(normalized.slice(4, 6), 16) / 255;
  return RGBA.fromValues(r, g, b, alpha);
}

function wrapHelpText(text: string, maxWidth: number): string[] {
  if (!text) return [''];
  if (maxWidth <= 0) return [text];

  const sourceLines = text.split('\n');
  const lines: string[] = [];

  for (const sourceLine of sourceLines) {
    const chunks = sourceLine.includes('•')
      ? sourceLine.split(/\s+•\s+/).map((chunk) => chunk.trim()).filter(Boolean)
      : sourceLine.split(/\s+/).filter(Boolean);
    const separator = sourceLine.includes('•') ? '  •  ' : ' ';
    let current = '';

    for (const chunk of chunks) {
      const candidate = current ? `${current}${separator}${chunk}` : chunk;
      if (current && candidate.length > maxWidth) {
        lines.push(current);
        current = chunk;
      } else {
        current = candidate;
      }
    }

    lines.push(current);
  }

  return lines.length ? lines : [''];
}

export interface GenericModalProps {
  /** Modal title displayed in header */
  title: string;
  /** Footer help text */
  helpText: string | HelpEntry[];
  /** Main content to render in the middle section */
  children: JSX.Element;
  /** Width as percentage of screen (0-1), default 0.5 (50%) */
  widthPercent?: number;
  /** Height as percentage of screen (0-1), default 0.7 (70%) */
  heightPercent?: number;
  /** Exact height in terminal lines. Overrides heightPercent when provided. */
  heightLines?: number;
  /** Optional custom header content (replaces default title) */
  customHeader?: JSX.Element;
  /** Hide modal header when child panels provide their own headers. */
  hideHeader?: boolean;
  /** Optional custom footer content (replaces default help text) */
  customFooter?: JSX.Element;
  /** Optional search mode/query for SearchHeader */
  searchMode?: boolean;
  searchQuery?: string;
  searchResultCount?: number;
  /** Optional filter/sort summary for FilterStatusBar */
  filterSummary?: string;
  sortSummary?: string;
  /** Click handler for backdrop */
  onBackdropClick?: () => void;
}

/**
 * GenericModal - Reusable modal component with consistent styling
 * 
 * Layout structure:
 * - HEADER: Title (or custom header)
 * - MIDDLE: Custom content (children)
 * - FOOTER: Help text (or custom footer)
 * 
 * Features:
 * - Consistent padding and spacing across all modals
 * - Configurable size (width/height percentages)
 * - Semi-transparent backdrop
 * - Flexbox layout with proper content overflow handling
 */
export function GenericModal(props: GenericModalProps) {
  const dimensions = useTerminalDimensions();

  const dialogWidth = () => Math.floor(dimensions().width * (props.widthPercent ?? 0.5));
  const dialogHeight = () => Math.min(dimensions().height, props.heightLines ?? Math.floor(dimensions().height * (props.heightPercent ?? 0.7)));
  const helpLines = createMemo(() => typeof props.helpText === 'string' ? wrapHelpText(props.helpText, Math.max(1, dialogWidth() - 4)) : ['']);

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
      backgroundColor={RGBA.fromValues(0, 0, 0, 0.35)}
      onMouseUp={() => props.onBackdropClick?.()}
    >
      {/* Dialog box */}
      <box
        backgroundColor={hexToRgba(uiColors.bgMantle, 0.92)}
        width={dialogWidth()}
        height={dialogHeight()}
        flexDirection="column"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        onMouseUp={(e: any) => {
          invokeGlobalSelectionMouseUpHandler();
          e.stopPropagation();
        }}
      >
        {/* HEADER */}
        {!props.hideHeader && (props.customHeader ? (
          props.customHeader
        ) : (
          <SearchHeader searchMode={props.searchMode} searchQuery={props.searchQuery} resultCount={props.searchResultCount}>
            <box
              style={{
                width: '100%',
                justifyContent: 'flex-start',
                flexDirection: 'row',
              }}
            >
              <text fg={uiColors.primary} attributes={TextAttributes.BOLD}>
                {props.title}
              </text>
            </box>
          </SearchHeader>
        ))}

        {/* FILTER STATUS */}
        <FilterStatusBar filterSummary={props.filterSummary} sortSummary={props.sortSummary} />

        {/* MIDDLE CONTENT */}
        <box
          style={{
            width: '100%',
            flexDirection: 'column',
            flexGrow: 1,
            flexShrink: 1,
            minHeight: 0,
            overflow: 'hidden',
          }}
        >
          {props.children}
        </box>

        {/* FOOTER */}
        {props.customFooter ? (
          props.customFooter
        ) : (
          <box
            style={{
              width: '100%',
              height: helpLines().length,
              justifyContent: 'flex-start',
              flexDirection: 'column',
              flexShrink: 0,
            }}
          >
            {Array.isArray(props.helpText) ? <HelpText entries={props.helpText} /> : <For each={helpLines()}>{(line) => <text style={{ fg: uiColors.textSecondary }}>{line}</text>}</For>}
          </box>
        )}
      </box>
    </box>
  );
}
