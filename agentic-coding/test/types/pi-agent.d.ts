// Loose module declaration so tests that exercise pi extensions type-check
// without the pi-coding-agent package installed in this project.
declare module '@earendil-works/pi-coding-agent' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export interface ExtensionAPI {
    [key: string]: any;
  }
}
