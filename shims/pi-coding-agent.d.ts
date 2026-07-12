// Minimal type shim for the Pi coding-agent extension API.
// The real types ship inside the pi binary; this declaration exists only so
// `tsc --noEmit` can type-check this extension in isolation (CI / local dev).
declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionAPI {
    registerCommand(
      name: string,
      definition: {
        description?: string;
        handler: (args: string, ctx: any) => void | Promise<void>;
      },
    ): void;
    sendUserMessage(text: string): void;
    [key: string]: unknown;
  }
}
