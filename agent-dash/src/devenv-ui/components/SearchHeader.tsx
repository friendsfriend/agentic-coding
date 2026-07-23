/** @jsxImportSource @opentui/solid */
import { type JSX } from 'solid-js';
import { colors, uiColors } from '../colors';

export interface SearchHeaderProps {
  searchMode?: boolean;
  searchQuery?: string;
  resultCount?: number;
  backgroundColor?: string;
  active?: boolean;
  children: JSX.Element;
}

export function SearchHeader(props: SearchHeaderProps) {
  const hasSearch = () => (props.searchQuery ?? '').length > 0;
  const searchContent = () => <box flexDirection="row">{[
    <text fg={colors.peach}>/</text>,
    <text fg={uiColors.textPrimary}>{props.searchQuery ?? ''}</text>,
    props.searchMode ? <text fg={uiColors.primary}>█</text> : null,
    !props.searchMode && hasSearch() && props.resultCount !== undefined ? <text fg={uiColors.textMuted}> ({props.resultCount} results)</text> : null,
  ].filter(Boolean)}</box>;

  return <box
    backgroundColor={props.backgroundColor ?? uiColors.bgSurface1}
    style={{
      width: '100%',
      height: 1,
      flexDirection: 'row',
      paddingLeft: 1,
      paddingRight: 1,
      flexShrink: 0,
    }}
  >{props.searchMode || hasSearch() ? searchContent() : props.children}</box>;
}
