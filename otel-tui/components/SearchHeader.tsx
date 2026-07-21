/** @jsxImportSource @opentui/solid */
import type { JSX } from 'solid-js';
import { uiColors } from '../ui/colors';

type Value<T> = T | (() => T);
const read = <T,>(value: Value<T> | undefined, fallback: T) => typeof value === 'function' ? (value as () => T)() : value ?? fallback;

export function SearchHeader(props: { searchMode?: Value<boolean>; searchQuery?: Value<string>; resultCount?: Value<number>; backgroundColor?: string; children?: JSX.Element }) {
  const query = () => read(props.searchQuery, '');
  const searching = () => read(props.searchMode, false);
  const count = () => read(props.resultCount, 0);
  const hasSearch = () => query().length > 0;
  const visible = () => searching() || hasSearch() || !!props.children;
  return <box backgroundColor={props.backgroundColor ?? uiColors.bgSurface1} style={{ width: '100%', height: visible() ? 1 : 0, flexDirection: 'row', paddingLeft: 1, paddingRight: 1, flexShrink: 0 }}>
    {searching() || hasSearch() ? <box flexDirection="row"><text fg={uiColors.warning}>/</text><text fg={uiColors.textPrimary}>{query()}</text>{searching() ? <text fg={uiColors.primary}>█</text> : null}{!searching() && hasSearch() ? <text fg={uiColors.textMuted}> ({count()} results)</text> : null}</box> : props.children}
  </box>;
}
