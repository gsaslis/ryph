import { describe, expect, it } from "vitest";
import {
  bareBrowserTool,
  browserToolOf,
  browserUnavailableReason,
  describeBrowserCall,
} from "./browser-tools";

describe("browserToolOf", () => {
  it("names the tool behind the browser's slug", () => {
    expect(browserToolOf("browser__click")).toBe("click");
    expect(browserToolOf("browser__")).toBeNull();
    expect(browserToolOf("memory__search")).toBeNull();
    expect(browserToolOf("bash")).toBeNull();
  });

  it("reads a live action's tool either way it is spelled", () => {
    expect(bareBrowserTool("click")).toBe("click");
    expect(bareBrowserTool("browser__click")).toBe("click");
  });
});

describe("describeBrowserCall", () => {
  it("quotes the element a click was on", () => {
    expect(describeBrowserCall("click", { ref: "e1", element: "Greet" })).toEqual({
      label: "Clicked “Greet”",
      subject: null,
    });
    expect(describeBrowserCall("click", { element: "Row", doubleClick: true }).label).toBe(
      "Double-clicked “Row”",
    );
  });

  it("names the page a navigate opened", () => {
    expect(describeBrowserCall("navigate", { url: "http://localhost:5173/" })).toEqual({
      label: "Opened a page",
      subject: "http://localhost:5173/",
    });
  });

  it("says what was typed and where", () => {
    expect(describeBrowserCall("type", { element: "Email", text: "a@b.c" })).toEqual({
      label: "Typed into “Email”",
      subject: "a@b.c",
    });
  });

  it("cuts a long description short and flattens its whitespace", () => {
    const label = describeBrowserCall("hover", { element: `A  very\n${"long ".repeat(30)}` }).label;
    expect(label.startsWith("Hovered over “A very long")).toBe(true);
    expect(label.endsWith("…”")).toBe(true);
    expect(label.length).toBeLessThan(80);
  });

  it("reads the direction of a scroll", () => {
    expect(describeBrowserCall("scroll", { deltaY: 400 }).label).toBe("Scrolled down");
    expect(describeBrowserCall("scroll", { deltaY: -400 }).label).toBe("Scrolled up");
    expect(describeBrowserCall("scroll", { deltaX: -10 }).label).toBe("Scrolled left");
    expect(describeBrowserCall("scroll", {}).label).toBe("Scrolled");
  });

  it("says what a wait was for", () => {
    expect(describeBrowserCall("wait_for", { text: "Done" }).label).toBe("Waited for “Done”");
    expect(describeBrowserCall("wait_for", { textGone: "Loading" }).label).toBe(
      "Waited for “Loading” to go",
    );
    expect(describeBrowserCall("wait_for", { seconds: 1 }).label).toBe("Waited 1 second");
  });

  it("numbers tabs from one", () => {
    expect(describeBrowserCall("tabs", { action: "select", index: 0 }).label).toBe(
      "Switched to tab 1",
    );
    expect(describeBrowserCall("tabs", { action: "list" }).label).toBe("Listed tabs");
  });

  it("shows the first line of a script", () => {
    expect(describeBrowserCall("evaluate", { function: "() => {\n  return 1;\n}" })).toEqual({
      label: "Ran a script",
      subject: "() => {",
    });
  });

  it("has a phrase for every tool when the arguments are missing or junk", () => {
    for (const tool of ["click", "type", "press_key", "select_option", "resize", "wait_for"]) {
      expect(describeBrowserCall(tool, null).label).not.toContain("undefined");
      expect(describeBrowserCall(tool, [1, 2]).label).not.toContain("null");
    }
    expect(describeBrowserCall("something_new", {}).label).toBe("Used something_new");
  });
});

describe("browserUnavailableReason", () => {
  it("says each of the control plane's reasons shortly, and anything else as it came", () => {
    const why = (tail: string) =>
      `the agent has a browser, but ${tail}, so this run started without one`;
    expect(
      browserUnavailableReason(
        why("this deployment runs none (RYPH_BROWSER_IMAGE is unset or off)"),
      ),
    )
      .toBe("This deployment doesn't run browsers.");
    expect(
      browserUnavailableReason(
        why("this deployment's provisioner cannot launch one (only kubernetes and docker can)"),
      ),
    ).toBe("This deployment's provisioner can't launch one.");
    expect(browserUnavailableReason(why('its harness "echo" cannot call MCP tools')))
      .toBe("The agent's harness can't use one.");
    expect(browserUnavailableReason("something new")).toBe("something new");
  });
});
