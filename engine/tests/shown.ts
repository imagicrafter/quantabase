/** Page HTML as read: undoes the email guard (src/app/email-guard.ts) so tests can look for addresses. */
export function shown(html: string | undefined): string {
  return (html ?? "").replace(/<span>&#64;<\/span>/g, "@").replace(/&#64;/g, "@");
}
