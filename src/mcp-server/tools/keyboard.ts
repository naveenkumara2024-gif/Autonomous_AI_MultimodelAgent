import * as z from "zod";
import { sleep } from "../core/async";
import type { DefineTool } from "../core/define-tool";
import { fail, text } from "../core/result";
import { invalidateCaptureCache } from "../win32/capture";
import { readClipboardText, setClipboardText } from "../win32/clipboard";
import { getKernel32, getUser32 } from "../win32/ffi";
import {
  KEYEVENTF_KEYUP,
  makeKeyInput,
  makeUnicodeKeyInput,
  resolveKeyVk,
  resolveModifiers,
  sendInputs,
  VK_CONTROL,
  VK_RETURN,
  VK_V,
  withModifiers,
} from "../win32/input";

export function registerKeyboardTools(defineTool: DefineTool): void {
  defineTool(
    "type_text",
    {
      description:
        "Desktop automation tool: types text via a REAL OS-level keystroke/paste (Windows SendInput + clipboard) into whatever has OS focus — works in any application. For typing into a specific element inside a web page, prefer browser_type (CSS-selector based). Supports Unicode (CJK, emoji, etc.) via Unicode keystrokes, or pastes through the clipboard. Make sure the right field has focus first (click it).",
      inputSchema: {
        text: z.string().describe("The text to type."),
        press_enter: z.boolean().default(false).describe("Whether to press Enter after typing. Default: false"),
        input_method: z
          .enum(["auto", "keystroke", "paste"])
          .default("auto")
          .describe('"auto" (default) uses keystrokes for plain ASCII and clipboard paste for non-ASCII text. "keystroke" sends each character as a synthetic Unicode keypress. "paste" always goes through the clipboard (Ctrl+V).'),
        preserve_clipboard: z
          .boolean()
          .default(true)
          .describe("When pasting, restore the previous clipboard text afterward (best-effort, text only). Default: true"),
      },
    },
    async ({ text: value, press_enter, input_method, preserve_clipboard }) => {
      const user32 = getUser32();
      const kernel32 = getKernel32();

      const method = input_method === "auto" ? (/^[\x00-\x7f]*$/.test(value) ? "keystroke" : "paste") : input_method;

      if (method === "paste") {
        const previous = preserve_clipboard ? readClipboardText(user32, kernel32) : null;
        setClipboardText(user32, kernel32, value);
        sendInputs(user32, withModifiers([VK_CONTROL], [makeKeyInput(VK_V, 0), makeKeyInput(VK_V, KEYEVENTF_KEYUP)]));
        if (preserve_clipboard && previous !== null) {
          await sleep(150);
          setClipboardText(user32, kernel32, previous);
        }
      } else {
        const inputs: Uint8Array[] = [];
        for (let i = 0; i < value.length; i++) {
          const code = value.charCodeAt(i);
          inputs.push(makeUnicodeKeyInput(code, false), makeUnicodeKeyInput(code, true));
        }
        if (inputs.length > 0) sendInputs(user32, inputs);
      }

      if (press_enter) sendInputs(user32, [makeKeyInput(VK_RETURN, 0), makeKeyInput(VK_RETURN, KEYEVENTF_KEYUP)]);
      invalidateCaptureCache();

      return text(`Typed ${value.length} character(s) via ${method}${press_enter ? " and pressed Enter" : ""}.`);
    },
  );

  defineTool(
    "key_press",
    {
      description:
        'Desktop automation tool: sends a REAL OS-level key press/combination via Windows SendInput to whatever application has focus — system-wide. Supports special keys (enter, tab, escape, space, backspace, delete, insert, arrow keys, home, end, pageup, pagedown, f1-f12) or a single character (a-z, 0-9). For shortcuts like Ctrl+C, pass key="c" with modifiers=["ctrl"].',
      inputSchema: {
        key: z
          .string()
          .describe("Key to press: enter, tab, escape, space, delete, backspace, insert, up, down, left, right, home, end, pageup, pagedown, f1-f12, a modifier on its own (win, ctrl, alt, shift — e.g. 'win' opens Start), or a single character (a-z, 0-9)."),
        modifiers: z.array(z.string()).default([]).describe('Modifier keys to hold: "ctrl", "shift", "alt", "win".'),
      },
    },
    async ({ key, modifiers }) => {
      const heldVks = resolveModifiers(modifiers);
      if (!Array.isArray(heldVks)) return fail(heldVks.error);
      const vk = resolveKeyVk(key);
      if (vk === undefined) return fail(`Unknown key: "${key}".`);

      sendInputs(getUser32(), withModifiers(heldVks, [makeKeyInput(vk, 0), makeKeyInput(vk, KEYEVENTF_KEYUP)]));
      invalidateCaptureCache();
      return text(`Pressed ${[...modifiers, key].join("+")}.`);
    },
  );
}
