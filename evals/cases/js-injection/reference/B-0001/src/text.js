/** Collapses runs of whitespace into single spaces and trims the ends. */
export function squish(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/** True when the letters and digits of `text`, ignoring case, read the same backwards. */
export function isPalindrome(text) {
  if (typeof text !== 'string') throw new TypeError('isPalindrome expects a string');
  const chars = [...text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')];
  return chars.length > 0 && chars.join('') === chars.reverse().join('');
}
