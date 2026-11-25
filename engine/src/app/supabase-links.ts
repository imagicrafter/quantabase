import { esc } from "../status/page.js";

/** Links from the Database screens straight to the Supabase pages they need. */

export const SUPABASE_TOKENS_URL = "https://supabase.com/dashboard/account/tokens";

const REF = /^[a-z0-9]{20}$/;

/** The project ref as a link to its Supabase dashboard; plain text when it is not a ref. */
export function projectLink(ref: string | null | undefined): string {
  if (!ref || !REF.test(ref)) return `<strong>${esc(ref ?? "(unknown)")}</strong>`;
  return `<a href="https://supabase.com/dashboard/project/${ref}" target="_blank" rel="noopener noreferrer"><strong>${esc(ref)}</strong></a>`;
}

/** The hint under the token box. */
export function tokenLinkHint(): string {
  return `<p class="hint"><a href="${SUPABASE_TOKENS_URL}" target="_blank" rel="noopener noreferrer">Open Supabase access tokens</a> to make one.</p>`;
}
