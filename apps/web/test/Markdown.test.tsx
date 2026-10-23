import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "@/components/Markdown";

describe("Markdown", () => {
  it("renders bold as strong", () => {
    const { container } = render(<Markdown source="**粗**" />);
    expect(container.querySelector("strong")?.textContent).toBe("粗");
  });
  it("shows raw script tags as text", () => {
    const { container } = render(<Markdown source="<script>alert(1)</script>" />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });
  it("shows raw img tags as text", () => {
    const { container } = render(<Markdown source="<img src=x onerror=alert(1)>" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });
  it("does not render javascript: links as anchors", () => {
    const { container } = render(<Markdown source="[x](javascript:alert(1))" />);
    expect(container.querySelector("a")).toBeNull();
    expect(container.innerHTML).not.toContain("javascript:");
    expect(container.textContent).toContain("x");
  });
  it("autolinks urls with safe target and rel", () => {
    const { container } = render(<Markdown source="https://docs.google.com/x" />);
    const a = container.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://docs.google.com/x");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
  });
  it("allows mailto links", () => {
    const { container } = render(<Markdown source="[m](mailto:a@b.co)" />);
    expect(container.querySelector("a")?.getAttribute("href")).toBe("mailto:a@b.co");
  });
});
