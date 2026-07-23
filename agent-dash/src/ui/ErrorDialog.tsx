/** @jsxImportSource @opentui/solid */
import { GenericModal } from './GenericModal';
import { ScrollableContent } from './ScrollableContent';
import { uiColors } from './colors';

export function ErrorDialog(props: { title: string; message: string; onClose: () => void; onScrollBoxReady?: (scrollBox: { scrollBy(dy: number): void }) => void }) {
  return <GenericModal title={`✗ ${props.title}`} titleColor={uiColors.error} help={[{ key: 'j/k', action: 'Scroll' }, { key: 'Esc', action: 'Close' }]} widthPercent={0.7} heightPercent={0.55} zIndex={1} onBackdropClick={props.onClose}>
    <box width="100%" flexGrow={1} flexDirection="column" paddingTop={1} paddingBottom={1}>
      <ScrollableContent onScrollBoxReady={props.onScrollBoxReady}>
        <text fg={uiColors.textPrimary}>{props.message}</text>
      </ScrollableContent>
    </box>
  </GenericModal>;
}
