/**
 * Domains that are not one company's: public email providers and endings
 * that many unrelated organisations share. The "Company domain" access level
 * refuses them, because "everyone at gmail.com" would be everyone.
 */

/**
 * Email providers anyone can sign up with. This is a guard against an honest
 * mistake, not a complete list: the preview also says, in words, that anyone
 * with an address at the domain gets in.
 */
const PUBLIC_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "fastmail.com",
  "hey.com",
  "duck.com",
  "qq.com",
  "163.com",
  "126.com",
  "sina.com",
  "mail.ru",
  "yandex.ru",
  "tuta.io",
  "tutanota.com",
  "web.de",
  "naver.com",
  "rediffmail.com",
  "hushmail.com",
  "mailbox.org",
  "posteo.de",
]);

/** The same providers under other endings: hotmail.co.uk, yahoo.co.jp, outlook.de. */
const PUBLIC_MAIL_NAMES: ReadonlySet<string> = new Set([
  "gmail",
  "googlemail",
  "outlook",
  "hotmail",
  "live",
  "msn",
  "yahoo",
  "ymail",
  "icloud",
  "aol",
  "proton",
  "protonmail",
  "gmx",
  "zoho",
  "yandex",
  "tutanota",
  "fastmail",
]);

/**
 * Endings that many unrelated organisations share. "Everyone at co.uk" is
 * not a company. (Not the full public suffix list: the common ones.)
 */
const SHARED_ENDINGS: ReadonlySet<string> = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "me.uk",
  "com.au",
  "net.au",
  "org.au",
  "edu.au",
  "co.nz",
  "co.jp",
  "ne.jp",
  "or.jp",
  "co.in",
  "co.za",
  "co.kr",
  "com.br",
  "com.mx",
  "com.cn",
  "com.sg",
  "com.hk",
  "com.tr",
  "com.ar",
  "github.io",
  "gitlab.io",
  "pages.dev",
  "workers.dev",
  "herokuapp.com",
  "vercel.app",
  "netlify.app",
  "web.app",
  "ondigitalocean.app",
  "cloudflareaccess.com",
  "blogspot.com",
  "wordpress.com",
]);

const SECOND_LEVEL = new Set(["co", "com", "net", "org", "ne", "or", "ac"]);

/** True for a domain that is not one company's: a mail provider or a shared ending. */
export function isSharedDomain(domain: string): boolean {
  if (PUBLIC_MAIL_DOMAINS.has(domain) || SHARED_ENDINGS.has(domain))
    return true;
  const labels = domain.split(".");
  const [first, second] = labels;
  const providerShaped =
    labels.length === 2 ||
    (labels.length === 3 && second !== undefined && SECOND_LEVEL.has(second));
  return providerShaped && first !== undefined && PUBLIC_MAIL_NAMES.has(first);
}
