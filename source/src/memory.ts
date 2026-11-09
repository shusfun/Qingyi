export class ByteLRU<T> {
  private map = new Map<string, { value: T; bytes: number }>();
  bytes = 0;
  constructor(readonly limit: number) {}
  get(key: string) {
    const item = this.map.get(key);
    if (!item) return;
    this.map.delete(key);
    this.map.set(key, item);
    return item.value;
  }
  set(key: string, value: T, bytes: number) {
    this.delete(key);
    if (bytes > this.limit) return;
    this.map.set(key, { value, bytes });
    this.bytes += bytes;
    while (this.bytes > this.limit) this.delete(this.map.keys().next().value!);
  }
  delete(key: string) {
    const item = this.map.get(key);
    if (item) {
      this.bytes -= item.bytes;
      this.map.delete(key);
    }
  }
  clear() {
    this.map.clear();
    this.bytes = 0;
  }
}
