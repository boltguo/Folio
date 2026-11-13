// Allow user-initiated links, while keeping the mail itself unable to run
// scripts, access the app's origin, submit forms, or load remote resources.
export const mailSandbox = "allow-popups allow-popups-to-escape-sandbox";

function linkHref(value: string): string | null {
  const href = value.trim();
  if (href.startsWith("#")) return href;
  try {
    // Some senders omit the scheme; never resolve relative paths against Folio.
    const url = new URL(href.startsWith("//") ? `https:${href}` : href);
    return ["http:", "https:", "mailto:"].includes(url.protocol)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function mailDocument(html: string): string {
  // Template contents are inert, including remote images, while being edited.
  const template = document.createElement("template");
  template.innerHTML = html;
  const content = template.content;
  content
    .querySelectorAll(
      "base, meta, script, noscript, iframe, object, embed, template, animate, set",
    )
    .forEach((node) => node.remove());
  content.querySelectorAll("a, area").forEach((link) => {
    const href = linkHref(
      link.getAttribute("href") || link.getAttribute("xlink:href") || "",
    );
    for (const attribute of [
      "href",
      "xlink:href",
      "target",
      "download",
      "ping",
      "attributionsrc",
    ])
      link.removeAttribute(attribute);
    link.setAttribute("rel", "noopener noreferrer");
    link.setAttribute("referrerpolicy", "no-referrer");
    if (href) {
      // A srcdoc's base URL is the app URL: keep fragment jumps in the mail.
      link.setAttribute(
        "href",
        href.startsWith("#") ? `about:srcdoc${href}` : href,
      );
      if (!href.startsWith("#")) link.setAttribute("target", "_blank");
    }
  });
  // Serialize in the template's inert owner document, without adopting mail
  // images into the live application document.
  const body = content.ownerDocument.createElement("div");
  body.appendChild(content);
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'"><style>body{overflow-wrap:anywhere;font:14px/1.6 sans-serif}img{max-width:100%}</style></head><body>${body.innerHTML}</body></html>`;
}
