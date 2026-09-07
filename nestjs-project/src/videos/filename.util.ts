export function extFromFilename(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot === -1 || dot === filename.length - 1) return 'mp4';
  const ext = filename
    .slice(dot + 1)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return ext.length > 0 ? ext : 'mp4';
}

export function baseName(filename: string): string {
  const part = filename.split('/').pop() || filename;
  const dot = part.lastIndexOf('.');
  return dot > 0 ? part.slice(0, dot) : part;
}
