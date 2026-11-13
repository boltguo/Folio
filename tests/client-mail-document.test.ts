import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { mailDocument, mailSandbox } from "../src/client/lib/mail-document";

beforeEach(() => {
  vi.stubGlobal("document", parseHTML("<html><body></body></html>").document);
});
afterEach(() => vi.unstubAllGlobals());

const render = (html: string) => parseHTML(mailDocument(html)).document;

describe("email links", () => {
  it("opens verification and invoice links outside the reader without an opener or referrer", () => {
    const document = render(`
      <a id="verify" href="https://account.example/verify?a=1&amp;b=2" target="_blank">Verify</a>
      <a id="invoice" href="https://billing.example/invoice" target="_top" ping="https://tracking.example/ping" download>Invoice</a>
      <a id="plain" href="http://example.net">Website</a>
      <area id="image-map" href="//example.net/map">
      <a id="contact" href="mailto:hello@example.net?subject=Hello">Contact</a>
    `);
    for (const id of ["verify", "invoice", "plain", "image-map", "contact"]) {
      const link = document.getElementById(id)!;
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
      expect(link.getAttribute("referrerpolicy")).toBe("no-referrer");
      expect(link.hasAttribute("ping")).toBe(false);
      expect(link.hasAttribute("download")).toBe(false);
    }
    expect(document.getElementById("verify")!.getAttribute("href")).toBe(
      "https://account.example/verify?a=1&b=2",
    );
    expect(document.getElementById("image-map")!.getAttribute("href")).toBe(
      "https://example.net/map",
    );
  });

  it.each([
    "javascript:alert(1)",
    "java&#x09;script:alert(1)",
    "data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;",
    "file:///etc/passwd",
    "/api/v1/auth/logout",
    "relative/path",
  ])("keeps unsafe or relative links inert: %s", (href) => {
    const link = render(
      `<a href="${href}" target="_blank">Read more</a>`,
    ).querySelector("a")!;
    expect(link.textContent).toBe("Read more");
    expect(link.hasAttribute("href")).toBe(false);
    expect(link.hasAttribute("target")).toBe(false);
  });

  it("preserves in-message anchors and normalizes SVG links too", () => {
    const document =
      render(`<a id="jump" href="#details" target="_top">Details</a>
      <div id="details">Details here</div>
      <svg><a xlink:href="https://example.net/svg"><text>Open</text>
      <set attributeName="href" to="javascript:alert(1)"></set></a></svg>`);
    expect(document.getElementById("jump")!.getAttribute("href")).toBe(
      "about:srcdoc#details",
    );
    expect(document.getElementById("jump")!.hasAttribute("target")).toBe(false);
    const svgLink = document.querySelector("svg a")!;
    expect(svgLink.getAttribute("href")).toBe("https://example.net/svg");
    expect(svgLink.hasAttribute("xlink:href")).toBe(false);
    expect(document.querySelector("set")).toBeNull();
  });

  it("keeps script and remote-resource restrictions when allowing links", () => {
    const document =
      render(`<html><head><base href="https://attacker.example/" target="_top">
      <meta http-equiv="refresh" content="0;url=https://attacker.example/"></head><body>
      <p>Message body</p><script>window.open('https://attacker.example/')</script>
      <img src="https://tracking.example/pixel"><iframe src="https://attacker.example/"></iframe>
      <div><template shadowrootmode="open"><a href="javascript:alert(1)" target="_blank">Hidden link</a></template></div>
      </body></html>`);
    expect(document.querySelector("p")!.textContent).toBe("Message body");
    expect(document.querySelector("base, script, iframe, template")).toBeNull();
    const policy = document
      .querySelector('meta[http-equiv="Content-Security-Policy"]')!
      .getAttribute("content")!;
    expect(document.querySelectorAll("meta")).toHaveLength(1);
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("img-src data:");
    expect(policy).toContain("form-action 'none'");
    expect(mailSandbox.split(" ")).toEqual([
      "allow-popups",
      "allow-popups-to-escape-sandbox",
    ]);
  });
});
