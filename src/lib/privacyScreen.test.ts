import { describe, it, expect, afterEach } from "vitest";
import { installWebCover } from "./privacyScreen";

const covered = () => document.documentElement.hasAttribute("data-privacy-cover");
const setHidden = (hidden: boolean) => {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event("visibilitychange"));
};

let remove: (() => void) | undefined;
afterEach(() => {
  remove?.();
  remove = undefined;
  setHidden(false);
});

describe("web privacy cover", () => {
  it("covers as soon as the window loses focus, before the page is reported hidden", () => {
    remove = installWebCover();
    window.dispatchEvent(new Event("blur"));
    expect(covered()).toBe(true);
    window.dispatchEvent(new Event("focus"));
    expect(covered()).toBe(false);
  });

  it("stays covered on refocus while the page is still hidden", () => {
    remove = installWebCover();
    setHidden(true);
    window.dispatchEvent(new Event("focus"));
    expect(covered()).toBe(true);
    setHidden(false);
    expect(covered()).toBe(false);
  });

  it("never leaves the page blank: a tap or key press clears a stuck cover", () => {
    remove = installWebCover();
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("pointerdown"));
    expect(covered()).toBe(false);
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("keydown"));
    expect(covered()).toBe(false);
  });

  it("removes its listeners and the cover when turned off", () => {
    remove = installWebCover();
    window.dispatchEvent(new Event("blur"));
    remove();
    remove = undefined;
    expect(covered()).toBe(false);
    window.dispatchEvent(new Event("blur"));
    expect(covered()).toBe(false);
  });
});
