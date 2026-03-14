/**
 * OFS Storage Metrics Collector
 *
 * Tracks dual-write performance metrics for monitoring:
 * - Success rates (local + TOS)
 * - Latency percentiles
 * - Retry counts
 * - Failure rates
 */

export interface OfsStorageMetrics {
  // Write operations
  totalWrites: number;
  localWriteSuccess: number;
  localWriteFailures: number;
  tosWriteSuccess: number;
  tosWriteFailures: number;
  tosWriteRetries: number;

  // Read operations
  totalReads: number;
  cacheHits: number;
  localHits: number;
  tosHits: number;
  readFailures: number;

  // Latency (ms)
  localWriteLatencySum: number;
  tosWriteLatencySum: number;
  localReadLatencySum: number;
  tosReadLatencySum: number;

  // Endpoint health
  endpointFailures: Map<string, number>;
  endpointSuccesses: Map<string, number>;
  lastEndpointRotation: number;

  // Timestamp
  startTime: number;
  lastUpdateTime: number;
}

export interface MetricsSnapshot {
  successRate: number; // Overall success rate
  tosSuccessRate: number; // TOS-specific success rate
  localSuccessRate: number;
  avgLocalWriteLatency: number;
  avgTosWriteLatency: number;
  avgLocalReadLatency: number;
  avgTosReadLatency: number;
  totalRetries: number;
  uptimeSeconds: number;
  healthyEndpoints: number;
  totalEndpoints: number;
}

export class OfsMetricsCollector {
  private metrics: OfsStorageMetrics;

  constructor() {
    this.metrics = {
      totalWrites: 0,
      localWriteSuccess: 0,
      localWriteFailures: 0,
      tosWriteSuccess: 0,
      tosWriteFailures: 0,
      tosWriteRetries: 0,
      totalReads: 0,
      cacheHits: 0,
      localHits: 0,
      tosHits: 0,
      readFailures: 0,
      localWriteLatencySum: 0,
      tosWriteLatencySum: 0,
      localReadLatencySum: 0,
      tosReadLatencySum: 0,
      endpointFailures: new Map(),
      endpointSuccesses: new Map(),
      lastEndpointRotation: Date.now(),
      startTime: Date.now(),
      lastUpdateTime: Date.now(),
    };
  }

  recordWrite(local: boolean): void {
    this.metrics.totalWrites++;
    this.metrics.lastUpdateTime = Date.now();
  }

  recordLocalWriteSuccess(latencyMs: number): void {
    this.metrics.localWriteSuccess++;
    this.metrics.localWriteLatencySum += latencyMs;
    this.metrics.lastUpdateTime = Date.now();
  }

  recordLocalWriteFailure(): void {
    this.metrics.localWriteFailures++;
    this.metrics.lastUpdateTime = Date.now();
  }

  recordTosWriteSuccess(latencyMs: number, endpoint?: string): void {
    this.metrics.tosWriteSuccess++;
    this.metrics.tosWriteLatencySum += latencyMs;
    if (endpoint) {
      this.metrics.endpointSuccesses.set(
        endpoint,
        (this.metrics.endpointSuccesses.get(endpoint) ?? 0) + 1,
      );
    }
    this.metrics.lastUpdateTime = Date.now();
  }

  recordTosWriteFailure(endpoint?: string): void {
    this.metrics.tosWriteFailures++;
    if (endpoint) {
      this.metrics.endpointFailures.set(
        endpoint,
        (this.metrics.endpointFailures.get(endpoint) ?? 0) + 1,
      );
    }
    this.metrics.lastUpdateTime = Date.now();
  }

  recordTosWriteRetry(): void {
    this.metrics.tosWriteRetries++;
    this.metrics.lastUpdateTime = Date.now();
  }

  recordRead(source: "cache" | "local" | "tos", latencyMs: number): void {
    this.metrics.totalReads++;
    switch (source) {
      case "cache":
        this.metrics.cacheHits++;
        break;
      case "local":
        this.metrics.localHits++;
        this.metrics.localReadLatencySum += latencyMs;
        break;
      case "tos":
        this.metrics.tosHits++;
        this.metrics.tosReadLatencySum += latencyMs;
        break;
    }
    this.metrics.lastUpdateTime = Date.now();
  }

  recordReadFailure(): void {
    this.metrics.readFailures++;
    this.metrics.lastUpdateTime = Date.now();
  }

  recordEndpointRotation(): void {
    this.metrics.lastEndpointRotation = Date.now();
  }

  getSnapshot(): MetricsSnapshot {
    const totalOps = this.metrics.localWriteSuccess + this.metrics.localWriteFailures;
    const localSuccess = totalOps > 0 ? this.metrics.localWriteSuccess / totalOps : 1;
    const tosOps = this.metrics.tosWriteSuccess + this.metrics.tosWriteFailures;
    const tosSuccess = tosOps > 0 ? this.metrics.tosWriteSuccess / tosOps : 1;

    // Overall success: local write success AND (TOS write success OR TOS not attempted)
    // If TOS writes haven't been attempted yet (tosOps === 0), consider it successful
    const attemptedDualWrites = this.metrics.totalWrites;
    let overallSuccess = 1;

    if (attemptedDualWrites > 0) {
      if (tosOps === 0) {
        // No TOS writes attempted, success based on local only
        overallSuccess = localSuccess;
      } else {
        // TOS writes attempted, success requires both local and TOS
        const successfulDualWrites = Math.min(
          this.metrics.localWriteSuccess,
          this.metrics.tosWriteSuccess,
        );
        overallSuccess = successfulDualWrites / attemptedDualWrites;
      }
    }

    // Calculate healthy endpoints (success rate > 50%)
    let healthyCount = 0;
    const allEndpoints = new Set<string>();

    // Collect all endpoint keys from both maps
    this.metrics.endpointSuccesses.forEach((_v, k) => allEndpoints.add(k));
    this.metrics.endpointFailures.forEach((_v, k) => allEndpoints.add(k));

    allEndpoints.forEach((endpoint) => {
      const successes = this.metrics.endpointSuccesses.get(endpoint) ?? 0;
      const failures = this.metrics.endpointFailures.get(endpoint) ?? 0;
      const total = successes + failures;
      if (total > 0 && successes / total > 0.5) {
        healthyCount++;
      }
    });

    return {
      successRate: overallSuccess,
      tosSuccessRate: tosSuccess,
      localSuccessRate: localSuccess,
      avgLocalWriteLatency:
        this.metrics.localWriteSuccess > 0
          ? this.metrics.localWriteLatencySum / this.metrics.localWriteSuccess
          : 0,
      avgTosWriteLatency:
        this.metrics.tosWriteSuccess > 0
          ? this.metrics.tosWriteLatencySum / this.metrics.tosWriteSuccess
          : 0,
      avgLocalReadLatency:
        this.metrics.localHits > 0 ? this.metrics.localReadLatencySum / this.metrics.localHits : 0,
      avgTosReadLatency:
        this.metrics.tosHits > 0 ? this.metrics.tosReadLatencySum / this.metrics.tosHits : 0,
      totalRetries: this.metrics.tosWriteRetries,
      uptimeSeconds: Math.floor((Date.now() - this.metrics.startTime) / 1000),
      healthyEndpoints: healthyCount,
      totalEndpoints: allEndpoints.size,
    };
  }

  getRawMetrics(): OfsStorageMetrics {
    return { ...this.metrics };
  }

  reset(): void {
    this.metrics = {
      totalWrites: 0,
      localWriteSuccess: 0,
      localWriteFailures: 0,
      tosWriteSuccess: 0,
      tosWriteFailures: 0,
      tosWriteRetries: 0,
      totalReads: 0,
      cacheHits: 0,
      localHits: 0,
      tosHits: 0,
      readFailures: 0,
      localWriteLatencySum: 0,
      tosWriteLatencySum: 0,
      localReadLatencySum: 0,
      tosReadLatencySum: 0,
      endpointFailures: new Map(),
      endpointSuccesses: new Map(),
      lastEndpointRotation: Date.now(),
      startTime: Date.now(),
      lastUpdateTime: Date.now(),
    };
  }

  /**
   * Format metrics as Prometheus-style text exposition format
   */
  toPrometheusFormat(prefix = "ofs_storage"): string {
    const snapshot = this.getSnapshot();
    const lines: string[] = [];

    lines.push(`# HELP ${prefix}_success_rate Overall dual-write success rate`);
    lines.push(`# TYPE ${prefix}_success_rate gauge`);
    lines.push(`${prefix}_success_rate ${snapshot.successRate.toFixed(4)}`);

    lines.push(`# HELP ${prefix}_tos_success_rate TOS write success rate`);
    lines.push(`# TYPE ${prefix}_tos_success_rate gauge`);
    lines.push(`${prefix}_tos_success_rate ${snapshot.tosSuccessRate.toFixed(4)}`);

    lines.push(`# HELP ${prefix}_local_success_rate Local write success rate`);
    lines.push(`# TYPE ${prefix}_local_success_rate gauge`);
    lines.push(`${prefix}_local_success_rate ${snapshot.localSuccessRate.toFixed(4)}`);

    lines.push(`# HELP ${prefix}_write_latency_ms Average write latency in milliseconds`);
    lines.push(`# TYPE ${prefix}_write_latency_ms gauge`);
    lines.push(
      `${prefix}_write_latency_ms{layer="local"} ${snapshot.avgLocalWriteLatency.toFixed(2)}`,
    );
    lines.push(`${prefix}_write_latency_ms{layer="tos"} ${snapshot.avgTosWriteLatency.toFixed(2)}`);

    lines.push(`# HELP ${prefix}_retries_total Total number of TOS write retries`);
    lines.push(`# TYPE ${prefix}_retries_total counter`);
    lines.push(`${prefix}_retries_total ${snapshot.totalRetries}`);

    lines.push(`# HELP ${prefix}_healthy_endpoints Number of healthy TOS endpoints`);
    lines.push(`# TYPE ${prefix}_healthy_endpoints gauge`);
    lines.push(`${prefix}_healthy_endpoints ${snapshot.healthyEndpoints}`);

    lines.push(`# HELP ${prefix}_total_endpoints Total number of TOS endpoints`);
    lines.push(`# TYPE ${prefix}_total_endpoints gauge`);
    lines.push(`${prefix}_total_endpoints ${snapshot.totalEndpoints}`);

    return lines.join("\n") + "\n";
  }
}
