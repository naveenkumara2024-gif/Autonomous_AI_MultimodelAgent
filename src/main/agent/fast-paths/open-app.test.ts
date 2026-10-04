import { describe, expect, test } from "bun:test";
import { matchOpenApp } from "./open-app";

describe("open-app fast path matcher", () => {
  const cases: Array<[string, string]> = [
    ["open whatsapp", "whatsapp"],
    ["Open WhatsApp", "WhatsApp"],
    ["launch calculator", "calculator"],
    ["start notepad.", "notepad"],
    ["can you open whatsapp", "whatsapp"],
    ["could you please open the calculator app", "calculator"],
    ["open up spotify", "spotify"],
    ["please open microsoft word", "microsoft word"],
    ["switch to visual studio code", "visual studio code"],
    ["hey, open whatsapp for me", "whatsapp"],
  ];
  for (const [text, app] of cases) {
    test(`matches: "${text}"`, () => expect(matchOpenApp(text)).toEqual({ appName: app }));
  }

  const negatives = [
    "open notepad and type hello world", // multi-clause: needs the supervisor
    "try open whatsapp from search icon and open it",
    "open notepad then save a file called test.txt",
    "open C:\\Users\\me\\report.docx", // a path, not an app
    "open google.com", // a URL
    "open a new tab", // not an app
    "start a timer for 5 minutes",
    "open the file report on my desktop",
    "open whatsapp, then message mom",
    "what apps are installed?",
    "open my email in chrome", // app + target: supervisor
    "open the first link on this page and read it to me",
  ];
  for (const text of negatives) {
    test(`does not match: "${text}"`, () => expect(matchOpenApp(text)).toBeNull());
  }
});
