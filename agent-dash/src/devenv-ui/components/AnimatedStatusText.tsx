/** @jsxImportSource @opentui/solid */
import type { Highlight } from './Highlight';
import { InlineProgressAnimation, type InlineProgressHighlights } from './InlineProgressAnimation';

export type StatusAnimationIntent =
  | 'start'
  | 'stop'
  | 'build'
  | 'test'
  | 'sync'
  | 'load'
  | 'ai'
  | 'script';

export interface StatusAnimationModel {
  label: string;
  tone?: Highlight;
  highlights?: InlineProgressHighlights;
}

const MODELS: Record<StatusAnimationIntent, StatusAnimationModel> = {
  start: { label: 'green + neutral · start / run', tone: 'positive' },
  stop: { label: 'red + neutral · stop', tone: 'negative' },
  build: { label: 'amber + neutral · build', tone: 'warning' },
  test: { label: 'amber + neutral · test', tone: 'warning' },
  sync: { label: 'blue + neutral · source sync', tone: 'highlight2' },
  load: { label: 'aurora + neutral · load', highlights: ['highlight1', 'primary', 'highlight3'] },
  ai: { label: 'aurora + neutral · AI work', highlights: ['highlight1', 'primary', 'highlight2'] },
  script: { label: 'amber + neutral · script', tone: 'warning' },
};

export function statusAnimationModel(intent: StatusAnimationIntent): StatusAnimationModel {
  return MODELS[intent];
}

export function statusAnimationIntentForOperation(operation?: string): StatusAnimationIntent {
  switch ((operation ?? '').toLowerCase()) {
    case 'start':
    case 'run': return 'start';
    case 'stop': return 'stop';
    case 'build': return 'build';
    case 'test': return 'test';
    case 'pull':
    case 'push':
    case 'fetch':
    case 'checkout': return 'sync';
    case 'script': return 'script';
    default: return 'load';
  }
}

export function statusAnimationIntentForText(text: string): StatusAnimationIntent {
  const value = text.toLowerCase();
  if (/stop|shut|cancel|remov|delet/.test(value)) return 'stop';
  if (/build|compil|bundl/.test(value)) return 'build';
  if (/test|check|validat/.test(value)) return 'test';
  if (/pull|push|fetch|checkout|clone|sync/.test(value)) return 'sync';
  if (/agent|review|analy|generat|ai\b/.test(value)) return 'ai';
  if (/script|task/.test(value)) return 'script';
  if (/start|run|launch|boot/.test(value)) return 'start';
  return 'load';
}

export interface AnimatedStatusTextProps {
  text: string;
  intent?: StatusAnimationIntent;
  backgroundColor?: string;
  duration?: number;
}

export function AnimatedStatusText(props: AnimatedStatusTextProps) {
  const model = () => statusAnimationModel(props.intent ?? statusAnimationIntentForText(props.text));
  return (
    <InlineProgressAnimation
      text={props.text}
      tone={model().tone}
      highlights={model().highlights}
      backgroundColor={props.backgroundColor}
      duration={props.duration}
    />
  );
}
