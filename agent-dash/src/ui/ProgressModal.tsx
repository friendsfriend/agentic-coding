/** @jsxImportSource @opentui/solid */
import { GenericModal } from './GenericModal';
import { uiColors } from './colors';

export function ProgressModal(props: { message: string }) {
  return <GenericModal title="Creating workflow" heightLines={7} help={[]}><box alignItems="center" justifyContent="center"><text fg={uiColors.primary}>● {props.message}</text></box></GenericModal>;
}
