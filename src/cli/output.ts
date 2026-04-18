export type Format = "json" | "table";

export function output(data: unknown, format: Format = "table"): void {
  if (format === "json") {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (Array.isArray(data)) {
    if (data.length === 0) {
      console.log("(empty)");
      return;
    }
    const rows = data.map((r) => (typeof r === "object" && r !== null ? r : { value: r }));
    const cols = Array.from(
      new Set(rows.flatMap((r) => Object.keys(r as Record<string, unknown>))),
    );
    const widths = cols.map((c) =>
      Math.max(c.length, ...rows.map((r) => String((r as Record<string, unknown>)[c] ?? "").length)),
    );
    const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
    console.log(cols.map((c, i) => pad(c, widths[i]!)).join("  "));
    console.log(widths.map((w) => "-".repeat(w)).join("  "));
    for (const r of rows) {
      console.log(
        cols
          .map((c, i) => pad(String((r as Record<string, unknown>)[c] ?? ""), widths[i]!))
          .join("  "),
      );
    }
    return;
  }
  if (typeof data === "object" && data !== null) {
    for (const [k, v] of Object.entries(data)) {
      console.log(`${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
    }
    return;
  }
  console.log(data);
}

export function err(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}
