export class LineLogBuffer {
  private pending = '';

  push(chunk?: string) {
    if (!chunk) {
      return [];
    }

    const normalized = chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const combined = this.pending + normalized;
    const parts = combined.split('\n');
    this.pending = parts.pop() ?? '';
    return parts.map((part) => part.trim()).filter(Boolean);
  }

  flush() {
    const line = this.pending.trim();
    this.pending = '';
    return line ? [line] : [];
  }
}
