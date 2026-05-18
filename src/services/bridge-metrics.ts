export interface BridgeMetricsSnapshot {
  startedAt: number;
  uptimeSeconds: number;
  activeRequests: number;
  activeStreamRequests: number;
  totals: {
    requests: number;
    streamRequests: number;
    nonStreamRequests: number;
    completed: number;
    succeeded: number;
    failed: number;
    upstreamTimeouts: number;
    upstreamErrors: number;
    streamInterruptions: number;
  };
  repair: {
    requestsWithMissingReasoning: number;
    eligibleAssistantMessages: number;
    repairedAssistantMessages: number;
    missingAssistantMessages: number;
    fullyRepairedRequests: number;
    partiallyRepairedRequests: number;
    unrepairedRequests: number;
    fillRate: number;
  };
  resolution: {
    explicit: number;
    bootstrap: number;
    contextKey: number;
    recentFallback: number;
    created: number;
  };
  lowConfidence: {
    allowed: number;
    disabledThinking: number;
    rejected: number;
    warnedOnly: number;
  };
  upstreamStatus: Record<string, number>;
  process: {
    pid: number;
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    nodeVersion: string;
  };
}

export class BridgeMetrics {
  private readonly startedAt = Date.now();
  private activeRequests = 0;
  private activeStreamRequests = 0;
  private totalRequests = 0;
  private totalStreamRequests = 0;
  private totalNonStreamRequests = 0;
  private totalCompleted = 0;
  private totalSucceeded = 0;
  private totalFailed = 0;
  private totalUpstreamTimeouts = 0;
  private totalUpstreamErrors = 0;
  private totalStreamInterruptions = 0;
  private requestsWithMissingReasoning = 0;
  private eligibleAssistantMessages = 0;
  private repairedAssistantMessages = 0;
  private missingAssistantMessages = 0;
  private fullyRepairedRequests = 0;
  private partiallyRepairedRequests = 0;
  private unrepairedRequests = 0;
  private resolutionExplicit = 0;
  private resolutionBootstrap = 0;
  private resolutionContextKey = 0;
  private resolutionRecentFallback = 0;
  private resolutionCreated = 0;
  private lowConfidenceAllowed = 0;
  private lowConfidenceDisabledThinking = 0;
  private lowConfidenceRejected = 0;
  private lowConfidenceWarnedOnly = 0;
  private readonly upstreamStatus = new Map<number, number>();

  beginRequest(stream: boolean): void {
    this.activeRequests += 1;
    this.totalRequests += 1;
    if (stream) {
      this.activeStreamRequests += 1;
      this.totalStreamRequests += 1;
      return;
    }
    this.totalNonStreamRequests += 1;
  }

  endRequest(stream: boolean, outcome: "success" | "failure"): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    if (stream) {
      this.activeStreamRequests = Math.max(0, this.activeStreamRequests - 1);
    }
    this.totalCompleted += 1;
    if (outcome === "success") {
      this.totalSucceeded += 1;
    } else {
      this.totalFailed += 1;
    }
  }

  recordRepair(eligibleCount: number, repairedCount: number, missingCount: number): void {
    if (eligibleCount <= 0) {
      return;
    }
    this.requestsWithMissingReasoning += 1;
    this.eligibleAssistantMessages += eligibleCount;
    this.repairedAssistantMessages += repairedCount;
    this.missingAssistantMessages += missingCount;

    if (missingCount === 0) {
      this.fullyRepairedRequests += 1;
    } else if (repairedCount > 0) {
      this.partiallyRepairedRequests += 1;
    } else {
      this.unrepairedRequests += 1;
    }
  }

  recordResolution(source: "explicit" | "bootstrap" | "context-key" | "recent-fallback" | "created"): void {
    if (source === "explicit") {
      this.resolutionExplicit += 1;
      return;
    }
    if (source === "bootstrap") {
      this.resolutionBootstrap += 1;
      return;
    }
    if (source === "context-key") {
      this.resolutionContextKey += 1;
      return;
    }
    if (source === "recent-fallback") {
      this.resolutionRecentFallback += 1;
      return;
    }
    this.resolutionCreated += 1;
  }

  recordLowConfidence(action: "allowed" | "disable-thinking" | "reject" | "warn"): void {
    if (action === "allowed") {
      this.lowConfidenceAllowed += 1;
      return;
    }
    if (action === "disable-thinking") {
      this.lowConfidenceDisabledThinking += 1;
      return;
    }
    if (action === "reject") {
      this.lowConfidenceRejected += 1;
      return;
    }
    this.lowConfidenceWarnedOnly += 1;
  }

  recordUpstreamStatus(status: number): void {
    this.upstreamStatus.set(status, (this.upstreamStatus.get(status) ?? 0) + 1);
    if (status >= 400) {
      this.totalUpstreamErrors += 1;
    }
  }

  recordUpstreamTimeout(): void {
    this.totalUpstreamTimeouts += 1;
  }

  recordStreamInterruption(): void {
    this.totalStreamInterruptions += 1;
  }

  snapshot(): BridgeMetricsSnapshot {
    const memory = process.memoryUsage();
    const eligible = this.eligibleAssistantMessages;
    return {
      startedAt: this.startedAt,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      activeRequests: this.activeRequests,
      activeStreamRequests: this.activeStreamRequests,
      totals: {
        requests: this.totalRequests,
        streamRequests: this.totalStreamRequests,
        nonStreamRequests: this.totalNonStreamRequests,
        completed: this.totalCompleted,
        succeeded: this.totalSucceeded,
        failed: this.totalFailed,
        upstreamTimeouts: this.totalUpstreamTimeouts,
        upstreamErrors: this.totalUpstreamErrors,
        streamInterruptions: this.totalStreamInterruptions
      },
      repair: {
        requestsWithMissingReasoning: this.requestsWithMissingReasoning,
        eligibleAssistantMessages: this.eligibleAssistantMessages,
        repairedAssistantMessages: this.repairedAssistantMessages,
        missingAssistantMessages: this.missingAssistantMessages,
        fullyRepairedRequests: this.fullyRepairedRequests,
        partiallyRepairedRequests: this.partiallyRepairedRequests,
        unrepairedRequests: this.unrepairedRequests,
        fillRate: eligible > 0 ? this.repairedAssistantMessages / eligible : 1
      },
      resolution: {
        explicit: this.resolutionExplicit,
        bootstrap: this.resolutionBootstrap,
        contextKey: this.resolutionContextKey,
        recentFallback: this.resolutionRecentFallback,
        created: this.resolutionCreated
      },
      lowConfidence: {
        allowed: this.lowConfidenceAllowed,
        disabledThinking: this.lowConfidenceDisabledThinking,
        rejected: this.lowConfidenceRejected,
        warnedOnly: this.lowConfidenceWarnedOnly
      },
      upstreamStatus: Object.fromEntries(
        [...this.upstreamStatus.entries()]
          .sort((left, right) => left[0] - right[0])
          .map(([status, count]) => [String(status), count])
      ),
      process: {
        pid: process.pid,
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        nodeVersion: process.version
      }
    };
  }
}
