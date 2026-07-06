// Minimal Prometheus text-exposition-format parser — enough to surface the
// modelgov_* domain counters and key gauges from GET /metrics in the console.
// Pure and dependency-free so it's unit-testable and CSP-safe.

export interface Sample {
  labels: Record<string, string>;
  value: number;
}

export interface MetricFamily {
  name: string;
  help?: string;
  type?: string;
  samples: Sample[];
}

const SAMPLE_RE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{.*\})?\s+(.+?)(?:\s+-?\d+)?$/;
const LABEL_RE = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

function parseValue(raw: string): number {
  const v = raw.trim();
  if (v === "+Inf") return Infinity;
  if (v === "-Inf") return -Infinity;
  if (v === "NaN") return NaN;
  return Number(v);
}

function parseLabels(block: string | undefined): Record<string, string> {
  const labels: Record<string, string> = {};
  if (!block) return labels;
  const inner = block.slice(1, -1); // strip { }
  let m: RegExpExecArray | null;
  LABEL_RE.lastIndex = 0;
  while ((m = LABEL_RE.exec(inner)) !== null) {
    // Single left-to-right pass over each backslash escape. Chained .replace()
    // calls would corrupt an escaped backslash (`\\n` decoding to `\`+newline
    // instead of `\`+`n`), because a later pass re-consumes backslashes an
    // earlier pass produced. Prometheus defines only \\, \n and \".
    labels[m[1]] = m[2].replace(/\\(.)/g, (_, c) => (c === "n" ? "\n" : c));
  }
  return labels;
}

/** Parse the exposition text into metric families keyed by name. */
export function parsePrometheus(text: string): MetricFamily[] {
  const families = new Map<string, MetricFamily>();
  const family = (name: string): MetricFamily => {
    let f = families.get(name);
    if (!f) {
      f = { name, samples: [] };
      families.set(name, f);
    }
    return f;
  };

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      const meta = /^#\s+(HELP|TYPE)\s+(\S+)\s+(.*)$/.exec(line);
      if (!meta) continue;
      const f = family(meta[2]);
      if (meta[1] === "HELP") f.help = meta[3];
      else f.type = meta[3];
      continue;
    }
    const m = SAMPLE_RE.exec(line);
    if (!m) continue;
    family(m[1]).samples.push({ labels: parseLabels(m[2]), value: parseValue(m[3]) });
  }
  return [...families.values()];
}

/** Sum every sample of a family (the total for a counter across its label sets). */
export function familyTotal(families: MetricFamily[], name: string): number {
  const f = families.find((x) => x.name === name);
  if (!f) return 0;
  return f.samples.reduce((sum, s) => sum + (Number.isFinite(s.value) ? s.value : 0), 0);
}

/** Families whose name starts with `prefix` (e.g. "modelgov_"), name-sorted. */
export function familiesWithPrefix(families: MetricFamily[], prefix: string): MetricFamily[] {
  return families.filter((f) => f.name.startsWith(prefix)).sort((a, b) => a.name.localeCompare(b.name));
}
