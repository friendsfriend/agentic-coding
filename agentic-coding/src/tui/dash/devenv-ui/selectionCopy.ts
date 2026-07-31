export type SelectionMouseUpHandler = () => void | Promise<void>;

let globalSelectionMouseUpHandler: SelectionMouseUpHandler | undefined;

export function setGlobalSelectionMouseUpHandler(handler: SelectionMouseUpHandler | undefined) {
  globalSelectionMouseUpHandler = handler;
  return () => {
    if (globalSelectionMouseUpHandler === handler) {
      globalSelectionMouseUpHandler = undefined;
    }
  };
}

export function invokeGlobalSelectionMouseUpHandler() {
  void globalSelectionMouseUpHandler?.();
}
