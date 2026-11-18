import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import ErrorBoundary from "./ErrorBoundary";

expect.extend(toHaveNoViolations);

function Bomb(): never {
  throw new Error("sensitive stack trace: db path /home/claude/secret.db");
}

describe("ErrorBoundary", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // React logs the thrown error to console itself on top of componentDidCatch
    // — silence both so the test output isn't noisy with the intentional throw.
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    window.location.hash = "";
  });

  it("renders children normally when nothing has crashed", () => {
    render(
      <ErrorBoundary>
        <div>Home screen content</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText("Home screen content")).toBeInTheDocument();
  });

  it("shows a plain-language fallback instead of the raw error when a child crashes", () => {
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    // The actual error message must never reach the screen — only the
    // console (verified below), never the DOM a screenshot or screen
    // reader would expose.
    expect(screen.queryByText(/sensitive stack trace/)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/secret\.db/);
  });

  it("still logs the real error to the console for debugging, just not on screen", () => {
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    const loggedToConsole = consoleErrorSpy.mock.calls.some((call: unknown[]) =>
      call.some(
        (arg) =>
          arg instanceof Error && arg.message.includes("sensitive stack trace"),
      ),
    );
    expect(loggedToConsole).toBe(true);
  });

  it("reassures the person their data is safe, without technical jargon", () => {
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/your data is untouched/i)).toBeInTheDocument();
  });

  it("offers a way back to a working screen", () => {
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(
      screen.getByRole("button", { name: "Try again" }),
    ).toBeInTheDocument();
    const backButton = screen.getByRole("button", { name: "Back to Home" });
    fireEvent.click(backButton);
    expect(window.location.hash).toBe("#/");
  });

  it('reveals the raw error only once the person explicitly opens "Technical details"', () => {
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    const toggle = screen.getByRole("button", { name: /technical details/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/sensitive stack trace/)).toBeInTheDocument();
  });

  it("has no automatically detectable a11y violations on the error screen", async () => {
    const { container } = render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(
      await axe(container, { rules: { "color-contrast": { enabled: false } } }),
    ).toHaveNoViolations();
  });
});

describe("ErrorBoundary — new version deployed while the page was open", () => {
  const reload = vi.fn();
  beforeEach(() => {
    sessionStorage.clear();
    reload.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("location", { ...window.location, reload });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  function StaleChunk(): never {
    throw new Error("Failed to fetch dynamically imported module: /assets/Analytics-old.js");
  }

  it("reloads once into the new version when a screen's file is missing", () => {
    render(
      <ErrorBoundary>
        <StaleChunk />
      </ErrorBoundary>,
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload for ordinary bugs", () => {
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  });

  it("shows the normal error screen (no reload loop) if it fails again right after reloading", () => {
    sessionStorage.setItem("mm_stale_reload_at", String(Date.now()));
    render(
      <ErrorBoundary>
        <StaleChunk />
      </ErrorBoundary>,
    );
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  });
});
