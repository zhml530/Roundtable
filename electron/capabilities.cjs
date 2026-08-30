// Pure desktop capability detection shared by Electron main tests and the
// renderer contract. Keep this file free of Electron imports so every branch
// is deterministic and unit-testable.

const DESKTOP_PLATFORMS = new Set(["darwin", "linux", "win32"]);

function normalizedPlatform(platform) {
  return DESKTOP_PLATFORMS.has(platform) ? platform : "other";
}

function nativeDesktopActions(platform) {
  const appleNative = normalizedPlatform(platform) === "darwin";
  return Object.freeze({
    appleMediaPermissions: appleNative,
    applePrivacySettings: appleNative,
    appleSpeech: appleNative,
  });
}

function linuxSession(platform, env) {
  if (platform !== "linux") return "unknown";
  const declared = String(env.XDG_SESSION_TYPE ?? "").toLowerCase();
  // A Wayland user session may also expose DISPLAY for XWayland. Prefer the
  // Wayland signal so the UI never bypasses portal-mediated behavior.
  if (declared === "wayland" || env.WAYLAND_DISPLAY) return "wayland";
  if (declared === "x11" || declared === "xorg") return "x11";
  if (env.DISPLAY) return "x11";
  return "headless";
}

function desktopCapabilities({
  platform = process.platform,
  env = process.env,
  packaged = false,
  homeDir = require("node:os").homedir(),
} = {}) {
  const hostPlatform = normalizedPlatform(platform);
  const isMac = hostPlatform === "darwin";
  const hostSession = linuxSession(hostPlatform, env);
  const linuxPreview = hostPlatform === "linux" && hostSession !== "headless";
  const screenPreview = {
    available: isMac || linuxPreview,
    interaction:
      isMac || hostSession === "x11"
        ? "direct"
        : hostSession === "wayland"
          ? "portal-picker"
          : "none",
  };
  if (!(isMac || linuxPreview)) {
    screenPreview.reasonCode =
      hostPlatform === "linux" ? "headless-session" : "unsupported-platform";
  }
  const dictation = {
    available: isMac,
    engine: isMac ? "apple-speech" : "none",
    onDevice: isMac,
  };
  if (!isMac) dictation.reasonCode = "unsupported-platform";
  return {
    host: {
      platform: hostPlatform,
      label:
        hostPlatform === "darwin"
          ? "macOS"
          : hostPlatform === "linux"
            ? "Linux"
            : hostPlatform === "win32"
              ? "Windows"
              : "Desktop",
      session: hostSession,
      packaged: Boolean(packaged),
      // so the renderer can show paths as ~/… without a Node builtin in
      // the sandboxed preload
      homeDir,
    },
    windowChrome: isMac ? "mac-inset" : "native",
    screenPreview,
    dictation,
  };
}

module.exports = {
  desktopCapabilities,
  linuxSession,
  nativeDesktopActions,
};
