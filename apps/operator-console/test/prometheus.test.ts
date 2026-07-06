import { describe, expect, it } from "vitest";
import { familiesWithPrefix, familyTotal, parsePrometheus } from "../src/prometheus";

const SAMPLE = `# HELP modelgov_chat_requests_total Chat requests by feature, policy decision, and outcome status.
# TYPE modelgov_chat_requests_total counter
modelgov_chat_requests_total{feature="support_chat",decision="allow",status="completed"} 42
modelgov_chat_requests_total{feature="support_chat",decision="block",status="blocked"} 3
# HELP modelgov_chat_cost_usd_total Cumulative settled model+safety cost (USD) by feature.
# TYPE modelgov_chat_cost_usd_total counter
modelgov_chat_cost_usd_total{feature="support_chat"} 1.2345
# HELP pg_pool_connections_total Total clients in the pg pool.
# TYPE pg_pool_connections_total gauge
pg_pool_connections_total 8
# a stray comment that is not HELP/TYPE
http_request_duration_seconds_bucket{le="+Inf"} 100
saturation_test_ratio +Inf
`;

describe("prometheus parser", () => {
  const families = parsePrometheus(SAMPLE);

  it("parses metric families with help, type, and labeled samples", () => {
    const reqs = families.find((f) => f.name === "modelgov_chat_requests_total");
    expect(reqs?.type).toBe("counter");
    expect(reqs?.help).toContain("Chat requests");
    expect(reqs?.samples).toHaveLength(2);
    expect(reqs?.samples[0].labels).toEqual({
      feature: "support_chat",
      decision: "allow",
      status: "completed",
    });
    expect(reqs?.samples[0].value).toBe(42);
  });

  it("parses unlabeled samples", () => {
    const pool = families.find((f) => f.name === "pg_pool_connections_total");
    expect(pool?.samples[0]).toEqual({ labels: {}, value: 8 });
  });

  it("keeps the +Inf bucket bound as a label, with its finite count as the value", () => {
    const bucket = families.find((f) => f.name === "http_request_duration_seconds_bucket");
    expect(bucket?.samples[0].labels.le).toBe("+Inf");
    expect(bucket?.samples[0].value).toBe(100);
  });

  it("parses a non-finite sample value (+Inf)", () => {
    const sat = families.find((f) => f.name === "saturation_test_ratio");
    expect(sat?.samples[0].value).toBe(Infinity);
  });

  it("familyTotal sums all label sets of a counter", () => {
    expect(familyTotal(families, "modelgov_chat_requests_total")).toBe(45);
    expect(familyTotal(families, "modelgov_chat_cost_usd_total")).toBeCloseTo(1.2345, 6);
    expect(familyTotal(families, "does_not_exist")).toBe(0);
  });

  it("familyTotal ignores non-finite sample values", () => {
    expect(familyTotal(families, "saturation_test_ratio")).toBe(0);
  });

  it("familiesWithPrefix filters and sorts by name", () => {
    const domain = familiesWithPrefix(families, "modelgov_");
    expect(domain.map((f) => f.name)).toEqual([
      "modelgov_chat_cost_usd_total",
      "modelgov_chat_requests_total",
    ]);
  });

  it("tolerates empty input", () => {
    expect(parsePrometheus("")).toEqual([]);
  });
});
