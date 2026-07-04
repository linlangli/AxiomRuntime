export function printTable(rows: Array<Record<string, string | number | null>>): void {
  if (!rows.length) {
    console.log("No data.");
    return;
  }

  const headers = Object.keys(rows[0]!);
  const widths = headers.map((header) =>
    Math.max(
      header.length,
      ...rows.map((row) => String(row[header] ?? "").length)
    )
  );

  const line = headers.map((header, index) => header.padEnd(widths[index]!)).join("  ");
  const separator = widths.map((width) => "-".repeat(width)).join("  ");
  console.log(line);
  console.log(separator);

  for (const row of rows) {
    console.log(headers.map((header, index) => String(row[header] ?? "").padEnd(widths[index]!)).join("  "));
  }
}

export function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}
