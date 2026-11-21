// Links in Discord messages are posted as hyperlinks ("[text](<url>)") so a long address does not fill the message: only the short
// text shows. The angle brackets around the address also stop Discord adding a preview card under the message.
//
// Link text is always fixed words chosen by us. If a caller ever passes text containing "[", "]" or a backslash, they are escaped so
// it cannot break out of the link. The address must be one we built (an https address with no spaces, ">" or ")"); anything else is
// refused rather than posted, because a broken address would swallow the rest of the message.

const SAFE_URL = /^https:\/\/[^\s<>()]+$/;

export function hyperlink(text, url) {
  if (!SAFE_URL.test(String(url))) throw new Error('hyperlink: the address is not a plain https address');
  return `[${String(text).replace(/[\\[\]]/g, '\\$&')}](<${url}>)`;
}
