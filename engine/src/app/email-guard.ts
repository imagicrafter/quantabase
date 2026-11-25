/**
 * Cloudflare's email obfuscation (on at DigitalOcean's edge, which we do not
 * control) rewrites any address it finds into "[email protected]" plus a
 * decode script our CSP blocks, and it ignored the email_off markers. Signed-in
 * pages must show real addresses, so no raw "x@y.z" is ever sent:
 *
 *   text                 local<span>&#64;</span>domain  (reads and copies as the address)
 *   attributes, <title>,
 *   <textarea>           local&#64;domain                (decoded by the browser; posts back as "@")
 *   <script>, <style>,
 *   comments             untouched
 *
 * Idempotent: guarded output has no raw address left to match.
 */

const EMAIL = /([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
const TOKEN = /(<!--[\s\S]*?-->|<[^>]*>)/;

const inText = (s: string): string => s.replace(EMAIL, "$1<span>&#64;</span>$2");
const encoded = (s: string): string => s.replace(EMAIL, "$1&#64;$2");

export function guardEmails(html: string): string {
  const parts = html.split(TOKEN);
  let raw: string | null = null; // inside script/style: copy as is
  let rcdata: string | null = null; // inside title/textarea: entities only
  return parts
    .map((part, i) => {
      const isTag = i % 2 === 1;
      if (!isTag) {
        if (raw) return part;
        return rcdata ? encoded(part) : inText(part);
      }
      if (part.startsWith("<!--")) return part;
      const name = /^<\/?\s*([a-zA-Z0-9]+)/.exec(part)?.[1]?.toLowerCase() ?? "";
      const closing = part.startsWith("</");
      if (raw) {
        if (closing && name === raw) raw = null;
        return part;
      }
      if (closing && name === rcdata) rcdata = null;
      else if (!closing && (name === "script" || name === "style")) raw = name;
      else if (!closing && (name === "title" || name === "textarea")) rcdata = name;
      return encoded(part);
    })
    .join("");
}
