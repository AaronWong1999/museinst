



export class TaskSecretScrubber {
  private secrets = new Set<string>();

  clear(): void {
    this.secrets.clear();
    this.verified = null;
  }

  register(value: unknown): void {
    const v = String(value ?? "");
    if (v.length >= 4) this.secrets.add(v);
  }


  scrub(text: string): string {
    let out = text;
    const sorted = [...this.secrets].sort((a, b) => b.length - a.length);
    for (const s of sorted) {
      if (out.includes(s)) out = out.split(s).join("***");
    }
    return out;
  }

  get size(): number {
    return this.secrets.size;
  }


  private verified: Array<{ type: string; value: string }> | null = null;
  setLoginVerification(entries: Array<{ type: string; value: string }>): void {
    this.verified = entries;
  }
  takeLoginVerification(): Array<{ type: string; value: string }> | null {
    const v = this.verified;
    return v;
  }
}
