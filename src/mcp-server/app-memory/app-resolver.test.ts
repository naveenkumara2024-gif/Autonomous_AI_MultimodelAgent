import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveApp, scoreAppName } from "./app-resolver";
import { LaunchCache } from "./launch-cache";

// A slice of a real Start-menu index (this machine's shell:AppsFolder), incl. the traps.
const APPS = [
  { name: "WhatsApp", app_id: "5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App" },
  { name: "WhatsApp Web", app_id: "Chrome._crx_hnpfjngllnfapefoaidbinmjnm" },
  { name: "Calculator", app_id: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App" },
  { name: "Notepad", app_id: "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App" },
  { name: "Notepad++", app_id: "{6D809377-6AF0-444B-8957-A3773F02200E}\\Notepad++\\notepad++.exe" },
  { name: "Visual Studio Code", app_id: "Microsoft.VisualStudioCode" },
  { name: "Word", app_id: "Microsoft.Office.WINWORD.EXE.15" },
  { name: "Uninstall Spotify", app_id: "{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}\\Spotify\\uninstall.exe" },
  { name: "Spotify Readme", app_id: "{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}\\Spotify\\readme.txt" },
  { name: "Epic Games Launcher", app_id: "C:\\Epic Games\\Launcher\\Portal\\Binaries\\Win32\\EpicGamesLauncher.exe" },
  { name: "Epic Games Setup", app_id: "C:\\Epic Games\\setup.exe" },
];

const pick = (q: string) => {
  const r = resolveApp(q, APPS);
  return r.kind === "match" ? r.app.name : r.kind;
};

describe("app resolver", () => {
  test("exact name beats a longer name that starts with it (WhatsApp vs WhatsApp Web)", () => {
    expect(pick("whatsapp")).toBe("WhatsApp");
    expect(pick("WhatsApp Web")).toBe("WhatsApp Web");
  });

  test("spacing/casing variants, word containment and acronyms resolve", () => {
    expect(pick("whats app")).toBe("WhatsApp");
    expect(pick("CALCULATOR")).toBe("Calculator");
    expect(pick("the calculator app")).toBe("Calculator");
    expect(pick("vsc")).toBe("Visual Studio Code");
    expect(pick("visual studio")).toBe("Visual Studio Code");
    expect(pick("epic games")).toBe("Epic Games Launcher");
  });

  test("uninstallers, setups and documents are never picked unless asked for by name", () => {
    expect(pick("spotify")).toBe("none");
    expect(pick("uninstall spotify")).toBe("Uninstall Spotify");
    expect(pick("spotify readme")).toBe("none"); // a document, not an app
  });

  test("notepad resolves to Notepad, not Notepad++", () => {
    expect(pick("notepad")).toBe("Notepad");
  });

  test("an equal-score tie is ambiguous, not a guess", () => {
    const r = resolveApp("studio", [
      { name: "Android Studio", app_id: "a" },
      { name: "OBS Studio", app_id: "b" },
    ]);
    expect(r.kind).toBe("ambiguous");
  });

  test("unknown names resolve to none", () => {
    expect(pick("definitelynotarealapp123")).toBe("none");
    expect(scoreAppName("zz", "Calculator")).toBe(0);
  });
});

describe("launch cache", () => {
  test("records, counts hits, survives reload, and invalidates", () => {
    const dir = mkdtempSync(join(tmpdir(), "launch-cache-"));
    try {
      const file = join(dir, "launch-cache.json");
      const a = new LaunchCache(file);
      a.record("WhatsApp", { app_id: "W", display_name: "WhatsApp", source: "start-menu", ms: 500 });
      a.record("whatsapp", { app_id: "W", display_name: "WhatsApp", source: "start-menu", ms: 6 });
      const b = new LaunchCache(file); // fresh instance = fresh process
      expect(b.get("whatsapp")).toMatchObject({ app_id: "W", hits: 2, last_ms: 6 });
      b.invalidate("WhatsApp");
      expect(new LaunchCache(file).get("whatsapp")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a query that now resolves to a different app resets the hit count", () => {
    const dir = mkdtempSync(join(tmpdir(), "launch-cache-"));
    try {
      const c = new LaunchCache(join(dir, "c.json"));
      c.record("mail", { app_id: "Old", display_name: "Mail", source: "start-menu", ms: 1 });
      c.record("mail", { app_id: "New", display_name: "Outlook", source: "start-menu", ms: 1 });
      expect(c.get("mail")).toMatchObject({ app_id: "New", hits: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
