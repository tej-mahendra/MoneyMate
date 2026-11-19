import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { useUpdateOnNavigate } from "./useUpdateOnNavigate";

function Probe() {
  useUpdateOnNavigate();
  const navigate = useNavigate();
  return <button onClick={() => navigate("/next")}>go</button>;
}
const reload = vi.fn();

function fakeServiceWorker(hasController: boolean) {
  const sw = new EventTarget() as EventTarget & { controller: unknown };
  sw.controller = hasController ? {} : null;
  vi.stubGlobal("navigator", { ...navigator, serviceWorker: sw });
  return sw;
}

beforeEach(() => {
  sessionStorage.clear();
  reload.mockClear();
  vi.stubGlobal("location", { ...window.location, reload });
});
afterEach(() => vi.unstubAllGlobals());

describe("useUpdateOnNavigate", () => {
  it("after an update takes over, the next screen change reloads into the new version", async () => {
    const sw = fakeServiceWorker(true);
    const user = userEvent.setup();
    render(<MemoryRouter><Probe /></MemoryRouter>);

    act(() => void sw.dispatchEvent(new Event("controllerchange")));
    expect(reload).not.toHaveBeenCalled(); // never mid-screen
    await user.click(screen.getByText("go"));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does nothing when no update has happened", async () => {
    fakeServiceWorker(true);
    const user = userEvent.setup();
    render(<MemoryRouter><Probe /></MemoryRouter>);
    await user.click(screen.getByText("go"));
    expect(reload).not.toHaveBeenCalled();
  });

  it("ignores the very first install claiming the page (that is not an update)", async () => {
    const sw = fakeServiceWorker(false);
    const user = userEvent.setup();
    render(<MemoryRouter><Probe /></MemoryRouter>);
    act(() => void sw.dispatchEvent(new Event("controllerchange")));
    await user.click(screen.getByText("go"));
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads only once per update", async () => {
    const sw = fakeServiceWorker(true);
    const user = userEvent.setup();
    render(<MemoryRouter><Probe /></MemoryRouter>);
    act(() => void sw.dispatchEvent(new Event("controllerchange")));
    await user.click(screen.getByText("go"));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("is harmless in browsers without service workers", async () => {
    vi.stubGlobal("navigator", { ...navigator, serviceWorker: undefined });
    const user = userEvent.setup();
    render(<MemoryRouter><Probe /></MemoryRouter>);
    await user.click(screen.getByText("go"));
    expect(reload).not.toHaveBeenCalled();
  });
});
