/**
 * The form text is searched in (R05.4): "Dvorak" finds "Dvořák", "Bjork"
 * finds "Björk", "Sigur Ros" finds "Sigur Rós".
 *
 * Compatibility-decompose (NFKD: full-width letters and ligatures become
 * plain ones), drop the Latin combining accents, fold the letters that do not
 * decompose (ø, æ, ß, ł, …), lowercase. Only U+0300–U+036F is dropped, so
 * Japanese voicing marks and other scripts keep their meaning; the result is
 * recomposed (NFC) so Japanese stays as it was typed.
 *
 * The same function is registered in SQLite (`search_text`), where triggers
 * keep the *_norm columns current, and applied to the query — both sides
 * always fold the same way.
 */
const FOLD: Record<string, string> = {
  ø: 'o',
  æ: 'ae',
  œ: 'oe',
  ß: 'ss',
  ł: 'l',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  ı: 'i',
  ħ: 'h',
};

export function searchText(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[øæœßłđðþıħ]/g, (c) => FOLD[c] ?? c)
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
}
