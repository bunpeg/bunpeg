export default class FileLocker {
  locks: Record<string, number> = {};

  has(key: string): boolean {
    return this.locks[key] !== undefined;
  }

  get(key: string): number | undefined {
    return this.locks[key];
  }

  keys() {
    return Object.keys(this.locks);
  }

  inc(key: string) {
    const curr = this.locks[key];
    if (curr) {
      this.locks[key] = curr + 1;
    } else {
      this.locks[key] = 1;
    }
  }

  dec(key: string) {
    const curr = this.locks[key];
    if (!curr) return;

    if (curr === 1) {
      delete this.locks[key];
    } else {
      this.locks[key] = curr - 1;
    }
  }

  clear() {
    Object.assign(this.locks, {});
  }
}
