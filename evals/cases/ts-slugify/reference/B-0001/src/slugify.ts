export function slugify(input: string, options: { maxLength?: number } = {}): string {
  const ascii = input.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
  let slug = ascii.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const max = options.maxLength;
  if (max !== undefined && slug.length > max) {
    const cut = slug.slice(0, max);
    const boundary = slug[max] === '-' ? max : cut.lastIndexOf('-');
    slug = boundary > 0 ? cut.slice(0, boundary) : cut;
  }
  return slug;
}
