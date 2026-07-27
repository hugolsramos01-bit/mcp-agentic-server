export interface ToolPerformanceMetrics {
  tool: string;
  workspaceId?: string;
  
  durationMs: number;
  outputCharacters: number;
  estimatedOutputTokens: number;
  
  subprocessCount: number;
  filesystemReads: number;
  filesystemStats: number;
  sqliteReads: number;
  sqliteWrites: number;
  
  cacheHits: number;
  cacheMisses: number;
  
  phases: Record<string, number>;
}
