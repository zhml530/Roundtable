// The narrow bridge the Electron preload exposes. Absent in the browser.

declare global {
type NativeSkillRecordingEvent = {
  type: "app" | "click" | "scroll" | "key" | "typing" | "clipboard" | "download";
  atMs: number;
  app?: string;
  windowTitle?: string;
  x?: number;
  y?: number;
  button?: "left" | "right" | "other";
  deltaY?: number;
  keycode?: number;
  meta?: boolean;
  control?: boolean;
  option?: boolean;
  shift?: boolean;
  /** Element identity for a click, from the accessibility tree. */
  role?: string;
  name?: string;
  identifier?: string;
  ancestry?: string[];
  /** Typed keystroke count (never the characters themselves). */
  keyCount?: number;
  /** Clipboard action kind — never its contents. */
  op?: "copy" | "cut" | "paste";
  /** Downloaded file name and its origin URLs. */
  filename?: string;
  whereFroms?: string[];
};

type SkillRecordingPayload = {
  name: string;
  description: string;
  durationMs: number;
  transcript: string;
  transcription?: { provider: "assemblyai"; model: string };
  audio?: string;
  events: Array<{
    type: "app" | "click" | "scroll" | "shortcut" | "typing" | "clipboard" | "download";
    atMs: number;
    app?: string;
    windowTitle?: string;
    direction?: "up" | "down";
    shortcut?: string;
    keyCount?: number;
    screenshot?: string;
    /** Element identity for a click. */
    role?: string;
    name?: string;
    identifier?: string;
    ancestry?: string[];
    /** Clipboard action kind — never its contents. */
    op?: "copy" | "cut" | "paste";
    /** Downloaded file name and its origin URLs. */
    filename?: string;
    whereFroms?: string[];
  }>;
};

  type DesktopCapabilities = {
    host: {
      platform: "darwin" | "linux" | "win32" | "other";
      /** The user's home folder, for showing paths as ~/… */
      homeDir?: string;
      label: string;
      session: "x11" | "wayland" | "headless" | "unknown";
      packaged: boolean;
    };
    windowChrome: "mac-inset" | "native";
    screenPreview: {
      available: boolean;
      interaction: "direct" | "portal-picker" | "none";
      reasonCode?: string;
    };
    dictation: {
      available: boolean;
      engine: "apple-speech" | "none";
      onDevice: boolean;
      reasonCode?: string;
    };
  };

  interface Window {
    ogb?: {
      platform: NodeJS.Platform;
      orchestration: {
        request(request: {
          path: string;
          method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
          headers?: Record<string, string>;
          body?: string | Uint8Array;
        }): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>;
        onEvent(cb: (frame: Record<string, unknown>) => void): () => void;
      };
      setTitleBarTheme(colors: { background: string; symbols: string }): void;
      getCapabilities(): Promise<DesktopCapabilities>;
      onCapabilitiesChanged(cb: (capabilities: DesktopCapabilities) => void): () => void;
      /** Arms one user-initiated display capture request from this frame. */
      beginScreenPreviewIntent(): boolean;
      screenFrame(): Promise<string | null>;
      /** Start native dictation. Call mode supplies endpointMs so silence
       * finalizes a turn; composer dictation omits it and remains manual. */
      speechStart(options?: { endpointMs?: number }): Promise<void>;
      speechStop(): Promise<void>;
      /** Finish capture and emit the recognizer's final transcript. */
      speechFinish?(): Promise<void>;
      onSpeechTranscript(
        cb: (line: { partial?: boolean; text?: string; error?: string }) => void,
      ): () => void;
      onSpeechEnd(cb: (info: { code: number | null; reason?: string }) => void): () => void;
      skillRecorder?: {
        permissions(): Promise<{ supported: boolean; reason?: string }>;
        start(): Promise<{ recording: boolean }>;
        stop(): Promise<{ recording: boolean }>;
        save(payload: SkillRecordingPayload): Promise<{ id: string; path: string; events: number }>;
        onEvent(cb: (event: NativeSkillRecordingEvent) => void): () => void;
        onEnd(cb: (info: { code: number | null; reason?: string }) => void): () => void;
      };
      transcription?: {
        status(): Promise<{ configured: boolean }>;
        setKey(value: string): Promise<{ configured: boolean }>;
        streamingToken(): Promise<{ token: string; expiresInSeconds: number }>;
      };
      /** Absolute path of a dropped File ("" when the drag carried no
       * file on disk). Absent in older builds of the shell. */
      getPathForFile?(file: File): string;
      /** {mic} TCC status: granted|denied|not-determined|unknown. Screen
       * status is deliberately absent — macOS 15+ caches it per-process,
       * so it lies for the whole session after a grant. */
      permStatus(): Promise<{ mic: string }>;
      /** Triggers the macOS microphone prompt; resolves true when granted. */
      permRequestMic(): Promise<boolean>;
      /** Opens System Settings on a privacy pane: mic|screen|speech|accessibility. */
      permOpenSettings(pane: "mic" | "screen" | "speech" | "accessibility"): Promise<void>;
      /** Copies an engine install command and opens a blank terminal. False
       * when no terminal could be launched; the clipboard still has it. */
      openInstallTerminal?(command: string): Promise<boolean>;
      /** Opens an http(s) link in the user's default browser. */
      openExternal?(url: string): Promise<boolean>;
      /** Receives a GitHub package URL opened through Roundtable://install. */
      onPackageInstall?(cb: (url: string) => void): () => void;
      /** Updates the native Dock/taskbar unread indicator. */
      setUnreadCount?(count: number): void;
      /** Native folder picker; resolves null when the user cancels. */
      pickFolder?(current?: string): Promise<string | null>;
      /** Writes the redacted diagnostics report to a user-chosen file;
       * resolves the path, or null when cancelled. */
      exportDiagnostics?(): Promise<string | null>;
      /** Save a provider credential through Electron's OS-backed store. */
      setCredential?(
        name: "composioApiKey" | "xaiApiKey" | "boxToken" | "opencodeGoApiKey" | "ttsKey" | "openaiImageApiKey",
        value: string,
      ): Promise<ConfigStatus>;
      /** In-app auto-update (packaged app only; dormant in dev). onState
       * fires immediately with the current state, then on transitions. */
      updater?: {
        check(): Promise<void>;
        download(): Promise<void>;
        /** quit-and-install the downloaded update */
        install(): Promise<void>;
        onState(cb: (s: UpdaterState) => void): () => void;
      };
    };
  }
}

export interface UpdaterState {
  status:
    | "idle"
    | "checking"
    | "available"
    | "downloading"
    | "downloaded"
    | "installing"
    | "error";
  version?: string;
  percent?: number;
  message?: string;
}

